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
      // 1. High-voltage power supply transformer buzz (sawtooth 58-65 Hz)
      this.electricOsc = this.audioCtx.createOscillator();
      this.electricGain = this.audioCtx.createGain();

      this.electricOsc.type = 'sawtooth';
      this.electricOsc.frequency.setValueAtTime(58, this.audioCtx.currentTime);
      this.electricGain.gain.setValueAtTime(0.55, this.audioCtx.currentTime);

      this.electricOsc.connect(this.electricGain);
      this.electricGain.connect(this.pannerNode || this.audioCtx.destination);
      this.electricOsc.start();

      // 2. High-frequency explosive spark snaps (50,000V ionization discharge)
      // Generates procedural white noise burst buffer
      const noiseLen = Math.floor(this.audioCtx.sampleRate * 0.04); // 40ms burst
      const noiseBuffer = this.audioCtx.createBuffer(1, noiseLen, this.audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (noiseLen * 0.25));
      }

      this.playSparkSnap = () => {
        if (!this.audioCtx || this.audioCtx.state === 'closed') return;
        try {
          const noiseSrc = this.audioCtx.createBufferSource();
          noiseSrc.buffer = noiseBuffer;

          const filter = this.audioCtx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(2600 + Math.random() * 1400, this.audioCtx.currentTime);
          filter.Q.setValueAtTime(2.8, this.audioCtx.currentTime);

          const snapGain = this.audioCtx.createGain();
          snapGain.gain.setValueAtTime(0.85, this.audioCtx.currentTime);
          snapGain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.035);

          noiseSrc.connect(filter);
          filter.connect(snapGain);
          snapGain.connect(this.pannerNode || this.audioCtx.destination);

          noiseSrc.start();
          noiseSrc.stop(this.audioCtx.currentTime + 0.04);
        } catch (_) {}
      };

      // Play immediate first snap for instant auditory response
      this.playSparkSnap();

      // TASER 7 discharges at ~19-22 pulses per second (approx every 48ms)
      this.electricInterval = setInterval(() => {
        if (this.electricGain && this.electricOsc && this.audioCtx) {
          const jitterGain = Math.random() * 0.35 + 0.45;
          this.electricGain.gain.setValueAtTime(jitterGain, this.audioCtx.currentTime);
          this.electricOsc.frequency.setValueAtTime(54 + Math.random() * 65, this.audioCtx.currentTime);
          this.playSparkSnap();
        }
      }, 48);
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
    this.playSparkSnap = null;
    if (this.electricOsc && this.electricGain && this.audioCtx) {
      try {
        this.electricGain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.05);
        this.electricOsc.stop(this.audioCtx.currentTime + 0.06);
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
