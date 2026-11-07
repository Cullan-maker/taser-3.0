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
        this.notifyStatus(true, 'Lyssnar...');
      };

      this.recognition.onresult = (event) => {
        const lastResultIndex = event.results.length - 1;
        if (lastResultIndex < 0) return;
        const result = event.results[lastResultIndex];
        if (!result || !result[0]) return;

        const transcript = result[0].transcript.trim();
        this.processTranscript(transcript);
      };

      this.recognition.onerror = (event) => {
        // 'no-speech' and 'aborted' are routine timeouts in ambient environments, ignore and allow onend to recover
        if (event.error === 'no-speech' || event.error === 'aborted') {
          return;
        }

        if (event.error === 'not-allowed') {
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
        }
      };

      this.recognition.onend = () => {
        // Auto-restart if user still wants voice active (True Continuous Listening on Mobile)
        if (this.isListening && !this.userExplicitStop) {
          if (this.restartTimeout) clearTimeout(this.restartTimeout);
          this.restartTimeout = setTimeout(() => {
            if (this.isListening && !this.userExplicitStop && this.recognition) {
              try {
                this.recognition.start();
                this.notifyStatus(true, 'Lyssnar...');
              } catch (e) {
                // If browser audio session is still cycling, retry after a short breather
                setTimeout(() => {
                  if (this.isListening && !this.userExplicitStop && this.recognition) {
                    try {
                      this.recognition.start();
                      this.notifyStatus(true, 'Lyssnar...');
                    } catch (err) {
                      // Already active
                    }
                  }
                }, 300);
              }
            }
          }, 150);
        } else {
          this.notifyStatus(false, 'AV');
        }
      };
    } catch (err) {
      console.warn('[TaserVoice] Initialization error:', err);
      this.isSupported = false;
    }
  }

  async start() {
    if (!this.isSupported || !this.recognition) {
      this.log("<span style='color:#e74c3c'>Web Speech API stöds inte i denna webbläsare. Använd Chrome eller Safari.</span>");
      return false;
    }

    this.userExplicitStop = false;

    // Explicit mobile microphone permission request before starting recognition
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        this.notifyStatus(false, 'Begär mikrofon...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Close probe stream immediately; recognition will manage its own audio
        stream.getTracks().forEach(t => t.stop());
      } catch (permErr) {
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
    }

    try {
      this.isListening = true;
      this.recognition.start();
      this.log("🎙️ <span style='color:#2ecc71; font-weight:bold;'>Röststyrning aktiv ('sv-SE').</span> Ropa: <i>'Jag har ett elchockvapen!'</i>, <i>'Beredd att använda det!'</i>, <i>'Släpp kniven!'</i> eller <i>'Lägg dig ner!'</i>");
      return true;
    } catch (e) {
      // Already running
      this.isListening = true;
      return true;
    }
  }

  stop() {
    this.userExplicitStop = true;
    this.isListening = false;
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

    // --- REGEX & FUZZY MATCHERS FÖR SVENSKA TAKTISKA FRASER ---
    // 1. Taktisk varning om elchockvapen ("Jag har ett elchockvapen")
    // Fångar: "elchockvapen", "elchock vapen", "elchocks vapen", "el chock vapen", "el-chockvapen", "elvapen", "taser"
    const regexElchock = /(?:jag\s+har\s+(?:ett\s+|en\s+)?)?(?:el[- ]?chock(?:s)?(?:[- ]?vapen)?|el[- ]?vapen|taser)/i;
    const isElchockVapen = regexElchock.test(lower) ||
      lower.includes('elchock') ||
      lower.includes('elvapen') ||
      lower.includes('taser');

    // 2. Taktisk varning om beredskap ("Jag är beredd att använda det")
    // Fångar: "beredd", "berädd", "berad", "redo", kombinerat med "använda det/den" eller ensamt i varningskontext
    const regexBeredd = /(?:jag\s+är\s+)?(?:bered[dt]|berädd|berad|redo)(?:\s+(?:på|att))?(?:\s+använda)?(?:\s+(?:det|den))?/i;
    const isBeredd = (regexBeredd.test(lower) && (lower.includes('använda') || lower.includes('det') || lower.includes('den') || lower.includes('bered') || lower.includes('berädd'))) ||
      /(?:använda\s+(?:det|den))/i.test(lower) ||
      (lower.includes('beredd') && lower.includes('använda')) ||
      (lower.includes('redo') && lower.includes('använda'));

    // 3. Formellt kommando "Lägg dig ner"
    // Fångar: "lägg dig ner", "lägg dig", "ner på marken", "ligg ner", "på marken", "lagg dig ner"
    const regexLaggDig = /(?:lägg|lagg|ligg)\s+(?:dig|er)(?:\s+ner)?/i;
    const isLaggDigNer = regexLaggDig.test(lower) ||
      lower.includes('lägg dig') ||
      lower.includes('lagg dig') ||
      lower.includes('ner på marken') ||
      lower.includes('ligg ner') ||
      lower.includes('på marken');

    // 4. Formellt kommando "Släpp kniven"
    // Fångar: "släpp kniven", "slapp kniven", "släpp vapnet", "kasta kniven", "kasta vapnet", "släpp den"
    const regexSlapp = /(?:släpp[a]?|slapp[a]?|kasta|lämna)\s+(?:kniven|vapnet|den|kniv)/i;
    const isSlappKniven = regexSlapp.test(lower) ||
      lower.includes('släpp kniven') ||
      lower.includes('slapp kniven') ||
      lower.includes('kasta kniven') ||
      lower.includes('släpp vapnet') ||
      (lower.startsWith('släpp') && lower.length < 16);

    // 5. Kommando "Stanna"
    const regexStanna = /(?:stanna|stopp|stå\s+still|halt)/i;
    const isStanna = regexStanna.test(lower);

    let matchedCommand = null;

    // Evaluera i prioriteringsordning
    if (isElchockVapen && isBeredd) {
      matchedCommand = 'VARNING_FULL';
    } else if (isElchockVapen) {
      matchedCommand = 'VARNING_ELCHOCKVAPEN';
    } else if (isBeredd) {
      matchedCommand = 'VARNING_BEREDD';
    } else if (isLaggDigNer) {
      matchedCommand = 'LAGG_DIG_NER';
    } else if (isSlappKniven) {
      matchedCommand = 'SLAPP_KNIVEN';
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
