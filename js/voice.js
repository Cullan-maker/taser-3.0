/**
 * TASER 7 Tactical Voice Command Engine
 * Implements continuous SpeechRecognition ('sv-SE') with permissions handling,
 * auto-restart resilience, and tactical probability evaluation.
 */

export class TaserVoice {
  constructor(options = {}) {
    this.options = options;
    this.recognition = null;
    this.isListening = false;
    this.isSupported = false;
    this.userExplicitStop = false;
    this.restartTimeout = null;
    this._restartAttempts = 0;

    this.onCommand = options.onCommand || null;
    this.onStatusChange = options.onStatusChange || null;
    this.onLog = options.onLog || null;

    this.init();
  }

  init() {
    const SpeechRecognition = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;

    if (!SpeechRecognition) {
      this.isSupported = false;
      return;
    }

    this.isSupported = true;
    try {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = false;
      this.recognition.lang = 'sv-SE';
      this.recognition.maxAlternatives = 3;

      this.recognition.onstart = () => {
        this._restartAttempts = 0;
        this.notifyStatus(true, 'Lyssnar...');
      };

      this.recognition.onresult = (event) => {
        const lastResultIndex = event.results.length - 1;
        if (lastResultIndex < 0) return;
        const result = event.results[lastResultIndex];
        if (!result || !result[0]) return;

        // Evaluera främsta alternativet (eller bästa matchning bland maxAlternatives)
        const transcript = result[0].transcript.trim();
        this.processTranscript(transcript);
      };

      this.recognition.onerror = (event) => {
        // 'no-speech' and 'aborted' are routine timeouts or WebXR audio transitions; allow onend to recover
        if (event.error === 'no-speech' || event.error === 'aborted') {
          return;
        }

        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.isListening = false;
          this.notifyStatus(false, 'Nekad');
          const inIframe = typeof window !== 'undefined' && window.self !== window.top;
          if (inIframe) {
            this.log("<span style='color:#f39c12; font-weight:bold;'>🔒 Preview-iframen blockerar mikrofonen</span> av webbläsarsäkerhetsskäl. Öppna appen direkt i en egen flik eller installera på mobilen för röststyrning.");
          } else {
            this.log("<span style='color:#e74c3c; font-weight:bold;'>Mikrofonbehörighet nekades.</span> Tillåt mikrofon i webbläsaren för röststyrning.");
          }
          return;
        }

        console.warn('[TaserVoice] SpeechRecognition error:', event.error);
        if (event.error === 'network') {
          this.log("<span style='color:#f39c12'>Röstigenkänning nätverksfel. Försöker igen...</span>");
        } else if (event.error === 'audio-capture') {
          // Under WebXR-start kan ljudenheten skifta kortvarigt — låt onend starta om automatiskt
          this.log("<span style='color:#f39c12'>Ljudenhet upptagen/växlar under AR — återansluter röstigenkänning...</span>");
        }
      };

      this.recognition.onend = () => {
        // Auto-restart if user or active WebXR session wants voice active (True Continuous Listening on Mobile & AR)
        if (this.isListening && !this.userExplicitStop) {
          this.scheduleRestart();
        } else {
          this.notifyStatus(false, 'AV');
        }
      };
    } catch (err) {
      console.warn('[TaserVoice] Initialization error:', err);
      this.isSupported = false;
    }
  }

  scheduleRestart() {
    if (!this.isListening || this.userExplicitStop || !this.recognition) return;
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
    const delays = [150, 300, 600, 1100, 1800];
    const delay = delays[Math.min(this._restartAttempts, delays.length - 1)];
    this._restartAttempts++;

    this.restartTimeout = setTimeout(() => {
      if (!this.isListening || this.userExplicitStop || !this.recognition) return;
      try {
        this.recognition.start();
        this.notifyStatus(true, 'Lyssnar...');
      } catch (e) {
        // Om webbläsarens ljudsession fortfarande växlar (t.ex. under WebXR), försök igen med backoff
        if (this._restartAttempts < 8) {
          this.scheduleRestart();
        }
      }
    }, delay);
  }

  ensureActive() {
    if (!this.isSupported || !this.recognition) return false;
    if (!this.isListening || this.userExplicitStop) return false;
    try {
      this.recognition.start();
      this.notifyStatus(true, 'Lyssnar...');
      return true;
    } catch (e) {
      // Redan aktiv eller startar via onend-schemaläggaren
      return true;
    }
  }

  async start(options = {}) {
    if (!this.isSupported || !this.recognition) {
      this.log("<span style='color:#e74c3c'>Web Speech API stöds inte i denna webbläsare. Använd Chrome eller Safari.</span>");
      return false;
    }

    this.userExplicitStop = false;
    this._restartAttempts = 0;

    if (this.isListening) {
      return this.ensureActive();
    }

    // Vid automatisk start inuti WebXR hoppar vi över extra getUserMedia-probe för att undvika
    // ljudkonflikt / transient activation-tapp med WebXR-sessionen; SpeechRecognition begär själv behörighet.
    if (!options.autoFromXR && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        this.notifyStatus(false, 'Begär mikrofon...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch (permErr) {
        if (permErr && (permErr.name === 'NotAllowedError' || permErr.name === 'PermissionDeniedError')) {
          this.isListening = false;
          this.notifyStatus(false, 'Nekad');
          const inIframe = typeof window !== 'undefined' && window.self !== window.top;
          if (inIframe) {
            this.log("<span style='color:#f39c12; font-weight:bold;'>🔒 Preview-iframen blockerar mikrofonåtkomst</span> (Permissions-Policy). Öppna URL:en i en ny flik eller i mobilen!");
          } else {
            this.log("<span style='color:#e74c3c; font-weight:bold;'>Mikrofonåtkomst ej godkänd:</span> Tillåt mikrofon i webbläsaren.");
          }
          return false;
        }
        // Övriga probing-fel (t.ex. upptagen ljudenhet): fortsätt och låt SpeechRecognition starta direkt
      }
    }

    try {
      this.isListening = true;
      this.recognition.start();
      this.notifyStatus(true, 'Lyssnar...');
      this.log("🎙️ <span style='color:#2ecc71; font-weight:bold;'>Röststyrning aktiv ('sv-SE').</span> Ropa: <i>'El, el, el!'</i>, <i>'Polis, stanna!'</i>, <i>'Släpp vapnet!'</i>, <i>'Backa!'</i>, <i>'Händerna upp!'</i>, <i>'Lägg dig ner!'</i> eller vapenkommandon (<i>'Osäkra'</i>, <i>'Säkra'</i>, <i>'Avfyra'</i>, <i>'Ladda om'</i>).");
      return true;
    } catch (e) {
      this.isListening = true;
      this.notifyStatus(true, 'Lyssnar...');
      return true;
    }
  }

  stop() {
    this.userExplicitStop = true;
    this.isListening = false;
    this._restartAttempts = 0;
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {}
    }
    this.notifyStatus(false, 'AV');
    this.log('🎙️ Röststyrning avstängd.');
  }

  toggle() {
    if (this.isListening) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  processTranscript(transcript) {
    if (!transcript) return;
    const raw = transcript.trim();
    const lower = raw.toLowerCase();
    this.log(`🗣️ Polisen: <i>"${raw}"</i>`);

    // --- 1. VAPENKOMMANDON VIA RÖST (Osäkra, Säkra, Avfyra, Ladda om) ---
    // Kontrollera "osäkra" FÖRE "säkra" så "osäkra" aldrig misstolkas som "säkra"
    const isOsakra = /\b(?:osäkra|osäkrat|osäkra\s+vapnet|avlägsna\s+säkring)\b/i.test(lower);
    const isSakra = !isOsakra && /\b(?:säkra|säkrat|säkra\s+vapnet|sätt\s+på\s+säkring)\b/i.test(lower);
    const isAvfyra = /\b(?:avfyra|skjut|eld)\b/i.test(lower);
    const isLaddaOm = /\b(?:ladda\s+om|omladda|omladdning|byt\s+kassett|ny\s+kassett)\b/i.test(lower) ||
      (lower === 'ladda');

    // --- 2. TAKTISKA SCENARIO TRIGGERS ---
    const regexStartScenario = /(?:starta|påbörja|aktivera|kör)\s+(?:angrepp|scenario|anfall)|(?:kom\s+då|börja|kör\s+igång)/i;
    const isStartScenario = regexStartScenario.test(lower) ||
      lower.includes('starta angrepp') ||
      lower.includes('starta scenario') ||
      lower.includes('starta anfall');

    const regexStopScenario = /(?:stoppa|avbryt|pausa)\s+(?:angrepp|scenario|anfall)|procedur(?:fas)?/i;
    const isStopScenario = regexStopScenario.test(lower) ||
      lower.includes('stoppa angrepp') ||
      lower.includes('avbryt angrepp') ||
      lower.includes('procedurfas');

    // --- 3. VARNINGSROP FÖRE SKOTT (Svensk terminologi: "El, el, el!" + elchockvapen + beredd) ---
    // Matchar upprepade eller fristående "el" med ordgräns (\bel\b) så vanliga ord som "eller"/"hela" inte falsktriggar
    const isVarningEl = /\bel(?:\s*[,!.\-]+\s*el|\s+el)+\b/i.test(lower) ||
      /^el[!.,\s]*$/i.test(lower) ||
      /\bel\s*vapen\b/i.test(lower);

    const regexElchock = /(?:jag\s+har\s+(?:ett\s+|en\s+)?)?(?:el[- ]?chock(?:s)?(?:[- ]?vapen)?|el[- ]?vapen)/i;
    const isElchockVapen = regexElchock.test(lower) ||
      lower.includes('elchock') ||
      lower.includes('elvapen');

    const regexBeredd = /(?:jag\s+är\s+)?(?:bered[dt]|berädd|berad|redo)(?:\s+(?:på|att))?(?:\s+använda)?(?:\s+(?:det|den))?/i;
    const isBeredd = (regexBeredd.test(lower) && (lower.includes('använda') || lower.includes('det') || lower.includes('den') || lower.includes('bered') || lower.includes('berädd'))) ||
      /(?:använda\s+(?:det|den))/i.test(lower) ||
      (lower.includes('beredd') && lower.includes('använda')) ||
      (lower.includes('redo') && lower.includes('använda'));

    // --- 4. BEFALLNINGAR SOM PÅVERKAR / STOPPAR SCENARIOT ---
    const regexLaggDig = /(?:lägg|lagg|ligg)\s+(?:dig|er)(?:\s+ner)?/i;
    const isLaggDigNer = regexLaggDig.test(lower) ||
      lower.includes('lägg dig') ||
      lower.includes('lagg dig') ||
      lower.includes('ner på marken') ||
      lower.includes('ligg ner') ||
      lower.includes('på marken');

    const isSlappVapnet = /(?:släpp[a]?|slapp[a]?|kasta|lämna)\s+(?:vapnet|tillhygget|batongen)\b/i.test(lower) ||
      lower.includes('släpp vapnet') ||
      lower.includes('kasta vapnet');

    const isSlappKniven = /(?:släpp[a]?|slapp[a]?|kasta|lämna)\s+(?:kniven|kniv|den)\b/i.test(lower) ||
      lower.includes('släpp kniven') ||
      lower.includes('slapp kniven') ||
      lower.includes('kasta kniven') ||
      (lower.startsWith('släpp') && !isSlappVapnet && lower.length < 18);

    const isHandernaUpp = /\bhänderna\s+(?:upp|i\s+vädret)\b/i.test(lower) ||
      /\bupp\s+med\s+händerna\b/i.test(lower) ||
      /\bvisa\s+händerna\b/i.test(lower) ||
      lower.includes('händerna upp');

    const isBacka = /\b(?:backa|gå\s+bakåt|håll\s+avstånd|kom\s+inte\s+närmare)\b/i.test(lower);

    const isPolisStanna = /\bpolis[,!.\s]+(?:stanna|stopp)\b/i.test(lower) ||
      (lower.includes('polis') && /\b(?:stanna|stopp)\b/i.test(lower));

    const isStanna = !isPolisStanna && /\b(?:stanna|stopp|stå\s+still|halt)\b/i.test(lower);

    let matchedCommand = null;

    // Evaluera i tydlig prioriteringsordning
    if (isStartScenario) {
      matchedCommand = 'STARTA_ANGREPP';
    } else if (isStopScenario) {
      matchedCommand = 'STOPPA_ANGREPP';
    } else if (isAvfyra) {
      matchedCommand = 'VAPEN_AVFYRA';
    } else if (isOsakra) {
      matchedCommand = 'VAPEN_OSAKRA';
    } else if (isSakra) {
      matchedCommand = 'VAPEN_SAKRA';
    } else if (isLaddaOm) {
      matchedCommand = 'VAPEN_LADDA_OM';
    } else if (isElchockVapen && isBeredd) {
      matchedCommand = 'VARNING_FULL';
    } else if (isVarningEl) {
      matchedCommand = 'VARNING_EL';
    } else if (isElchockVapen) {
      matchedCommand = 'VARNING_ELCHOCKVAPEN';
    } else if (isBeredd) {
      matchedCommand = 'VARNING_BEREDD';
    } else if (isLaggDigNer) {
      matchedCommand = 'LAGG_DIG_NER';
    } else if (isSlappKniven) {
      matchedCommand = 'SLAPP_KNIVEN';
    } else if (isSlappVapnet) {
      matchedCommand = 'SLAPP_VAPNET';
    } else if (isHandernaUpp) {
      matchedCommand = 'HANDERNA_UPP';
    } else if (isBacka) {
      matchedCommand = 'BACKA';
    } else if (isPolisStanna) {
      matchedCommand = 'POLIS_STANNA';
    } else if (isStanna) {
      matchedCommand = 'STANNA';
    }

    if (matchedCommand && typeof this.onCommand === 'function') {
      this.onCommand(matchedCommand, raw);
    }
  }

  simulateCommand(commandStr) {
    this.processTranscript(commandStr);
  }

  notifyStatus(active, label) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(active, label);
    }
  }

  log(msg) {
    if (typeof this.onLog === 'function') {
      this.onLog(msg);
    }
  }
}
