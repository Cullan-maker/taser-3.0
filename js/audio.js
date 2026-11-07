/**
 * TASER 7 Audio Synthesizer & Media Session API Controller
 * Provides zero-dependency procedural audio synthesis and lockscreen controls.
 */

export class TaserAudio {
  constructor(fsm) {
    this.fsm = fsm;
    this.audioCtx = null;
    this.isInitialized = false;
    this.pannerNode = null;
    this.electricOsc = null;
    this.electricGain = null;
    this.electricInterval = null;
    this.silentAudioEl = null;

    this.setupMediaSession();
  }

  init() {
    if (!this.isInitialized) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
          if (this.audioCtx.createStereoPanner) {
            this.pannerNode = this.audioCtx.createStereoPanner();
            this.pannerNode.connect(this.audioCtx.destination);
          }
        }
        this.isInitialized = true;
      } catch (err) {
        console.warn('[TaserAudio] AudioContext init failed:', err);
      }
    }

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    // Initialize silent background loop for MediaSession persistence on mobile
    this.ensureSilentLoop();
  }

  ensureSilentLoop() {
    if (!this.silentAudioEl && typeof document !== 'undefined') {
      try {
        // Continuous 1-second silent WAV base64
        const silentWav = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        const audio = new Audio(silentWav);
        audio.loop = true;
        audio.volume = 0.5; // Set to midpoint so volume up/down triggers delta
        this.silentAudioEl = audio;

        let volumeDebounce = false;
        // Listen for hardware volume button presses via HTMLAudioElement volumechange
        audio.addEventListener('volumechange', () => {
          if (volumeDebounce) return;
          volumeDebounce = true;

          // Trigger TASER 7 Warning Arc
          if (typeof window !== 'undefined' && window.pressSingleWarning) {
            window.pressSingleWarning();
          } else if (this.fsm) {
            this.fsm.pressSingleWarning();
          }

          // Reset volume to 0.5 after delta detection to capture subsequent button clicks
          setTimeout(() => {
            if (this.silentAudioEl) {
              this.silentAudioEl.volume = 0.5;
            }
            volumeDebounce = false;
          }, 250);
        });
      } catch (e) {
        console.warn('[TaserAudio] Silent loop creation fallback:', e);
      }
    }
  }

  setupMediaSession() {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'TASER 7 Tactical Drill',
          artist: 'Axon TASER 7 Simulator',
          album: 'Procedursimulator v7.47',
          artwork: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png' }
          ]
        });

        // Varningsbåge via Media Keys (Volymknappar / Next Track / Previous Track)
        const triggerWarnArc = () => {
          if (typeof window !== 'undefined' && window.pressSingleWarning) {
            window.pressSingleWarning();
          } else if (this.fsm) {
            this.fsm.pressSingleWarning();
          }
        };

        const mediaActions = ['nexttrack', 'previoustrack', 'seekforward', 'seekbackward'];
        for (const action of mediaActions) {
          try {
            navigator.mediaSession.setActionHandler(action, triggerWarnArc);
          } catch (err) {
            // Some actions may not be supported by every browser engine
          }
        }

        // Lockscreen and tactical wearable controls
        navigator.mediaSession.setActionHandler('play', () => {
          if (this.fsm) {
            if (this.fsm.isSafe) {
              this.fsm.toggleSafety();
            } else {
              if (typeof window !== 'undefined' && window.pressTrigger) {
                window.pressTrigger();
              } else {
                this.fsm.pressTrigger();
              }
            }
          }
        });

        navigator.mediaSession.setActionHandler('pause', () => {
          if (this.fsm && this.fsm.cycleTimer) {
            this.fsm.stopCycle();
          }
        });

        navigator.mediaSession.setActionHandler('stop', () => {
          if (this.fsm) {
            this.fsm.reset();
          }
        });
      } catch (err) {
        console.warn('[TaserAudio] MediaSession registration error:', err);
      }
    }
  }

  updateMediaSessionPlayback(state) {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = state; // 'playing' | 'paused' | 'none'
      } catch (err) {}
    }
  }

  playPopSound() {
    this.init();
    if (!this.audioCtx) return;

    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      
      // Nitrogen gas release impulse (300Hz down to 40Hz with sharp envelope)
      osc.type = 'square';
      osc.frequency.setValueAtTime(320, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(35, this.audioCtx.currentTime + 0.12);

      gain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.005, this.audioCtx.currentTime + 0.16);

      osc.connect(gain);
      gain.connect(this.pannerNode || this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.16);

      if (this.silentAudioEl) {
        this.silentAudioEl.play().catch(() => {});
      }
    } catch (e) {
      console.warn('Audio playPop failed:', e);
    }
  }

  startElectricSound() {
    this.init();
    if (!this.audioCtx) return;

    this.stopElectricSound();
    this.updateMediaSessionPlayback('playing');

    try {
      this.electricOsc = this.audioCtx.createOscillator();
      this.electricGain = this.audioCtx.createGain();

      // TASER 7 operates at 19 pulses per second with high harmonic content
      this.electricOsc.type = 'sawtooth';
      this.electricOsc.frequency.setValueAtTime(55, this.audioCtx.currentTime);

      this.electricGain.gain.setValueAtTime(0.7, this.audioCtx.currentTime);

      this.electricOsc.connect(this.electricGain);
      this.electricGain.connect(this.pannerNode || this.audioCtx.destination);

      this.electricOsc.start();

      // Spark jitter
      this.electricInterval = setInterval(() => {
        if (this.electricGain && this.electricOsc && this.audioCtx) {
          const jitterGain = Math.random() * 0.4 + 0.6;
          this.electricGain.gain.setValueAtTime(jitterGain, this.audioCtx.currentTime);
          this.electricOsc.frequency.setValueAtTime(50 + Math.random() * 65, this.audioCtx.currentTime);
        }
      }, 30);
    } catch (e) {
      console.warn('Audio startElectric failed:', e);
    }
  }

  stopElectricSound() {
    this.updateMediaSessionPlayback('paused');
    if (this.electricInterval) {
      clearInterval(this.electricInterval);
      this.electricInterval = null;
    }
    if (this.electricOsc && this.electricGain && this.audioCtx) {
      try {
        this.electricGain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.08);
        this.electricOsc.stop(this.audioCtx.currentTime + 0.09);
      } catch (e) {}
      this.electricOsc = null;
      this.electricGain = null;
    }
  }

  suspectSpeak(text, onEnd) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const msg = new SpeechSynthesisUtterance(text);
      msg.lang = 'sv-SE';
      msg.pitch = 0.65;
      msg.rate = 1.15;
      if (typeof onEnd === 'function') {
        msg.onend = onEnd;
      }
      window.speechSynthesis.speak(msg);
    } catch (e) {}
  }
}
