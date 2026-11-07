/**
 * TASER 7 Finite State Machine (FSM)
 * High-reliability tactical state controller for Axon TASER 7 device.
 * Manages physical device states, OLED CID display states, and function tests.
 */

export const DeviceState = Object.freeze({
  UNPOWERED: 'UNPOWERED',
  SAFE: 'SAFE',
  BOOT: 'BOOT',
  FUNK_MODE: 'FUNK_MODE',
  ACTIVE: 'ACTIVE',
  CYCLING: 'CYCLING'
});

export const ChamberState = Object.freeze({
  EMPTY: 'empty',
  LOADED: 'loaded',
  FIRED: 'fired'
});

export class TaserFSM {
  constructor(options = {}) {
    this.options = options;
    
    // Core physical hardware states
    this.hasBattery = false;
    this.isSafe = true;
    this.chamber1 = ChamberState.EMPTY;
    this.chamber2 = ChamberState.EMPTY;
    this.activeChamber = 1;
    this.stealthMode = false;
    this.heavyClothing = false;
    this.displayState = 'OFF'; // 'OFF' | 'BOOT' | 'FUNK_MODE' | 'ACTIVE' | 'CYCLING'
    
    // Runtime timers
    this.cycleTimer = null;
    this.cycleCount = 0;
    this.cycleType = null; // 'DARTS' | 'WARNING_ARC' | 'DRIVE_STUN'
    this.bootTimer = null;

    // Observer listeners
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, payload = {}) {
    for (const listener of this.listeners) {
      try {
        listener(event, this, payload);
      } catch (err) {
        console.error('[TaserFSM] Listener error:', err);
      }
    }
  }

  getState() {
    if (!this.hasBattery) return DeviceState.UNPOWERED;
    if (this.cycleTimer !== null) return DeviceState.CYCLING;
    if (this.displayState === 'BOOT') return DeviceState.BOOT;
    if (this.isSafe) return DeviceState.SAFE;
    if (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY) {
      return DeviceState.FUNK_MODE;
    }
    return DeviceState.ACTIVE;
  }

  getEffectiveAngles() {
    return {
      activeAngle: this.activeChamber === 1 ? 12 : 3.5,
      chamber1Angle: 12,
      chamber2Angle: 3.5
    };
  }

  /**
   * 1. Sätt i batteriet -> Displayen visar en BOOT-sekvens i 3 sekunder.
   * Ta ur batteriet -> Vapnet stängs av.
   */
  toggleBattery() {
    if (!this.isSafe) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>FEL: Säkra vapnet innan batteribyte!</span>" });
      return false;
    }

    this.hasBattery = !this.hasBattery;
    if (!this.hasBattery) {
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }
      this.stopCycle();
      this.stealthMode = false;
      this.displayState = 'OFF';
      this.notify('LOG', { message: 'Batteri urtaget. Enhet avstängd.' });
    } else {
      // Start 3-second BOOT sequence
      this.displayState = 'BOOT';
      this.notify('LOG', { message: "<span style='color:#2ecc71'>Batteri isatt. Startar BOOT-sekvens (3s)...</span>" });
      
      if (this.bootTimer) clearTimeout(this.bootTimer);
      this.bootTimer = setTimeout(() => {
        if (this.displayState === 'BOOT') {
          if (this.isSafe) {
            this.displayState = 'OFF';
            this.notify('LOG', { message: 'BOOT klar. Vapnet är säkrat och displayen släcks.' });
          } else {
            this.displayState = (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY)
              ? 'FUNK_MODE'
              : 'ACTIVE';
          }
          this.notify('DISPLAY_CHANGED');
        }
      }, 3000);
    }

    this.notify('BATTERY_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  /**
   * Kassettkontroll och byte:
   * KRITISK TAKTISK REGEL: Vapnet MÅSTE vara säkrat innan kassetter matas ut eller byts!
   */
  toggleCassette() {
    if (!this.isSafe) {
      this.notify('LOG', {
        message: "<span style='color:#e74c3c; font-weight:bold; font-size:9.5px;'>⚠️ TAKTISKT FEL: Vapnet måste SÄKRAS innan kassetter kan matas ut eller bytas!</span>"
      });
      return false;
    }

    if (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY) {
      // Laddning av kassetter
      this.chamber1 = ChamberState.LOADED;
      this.chamber2 = ChamberState.LOADED;
      this.activeChamber = 1;
      this.notify('LOG', {
        message: "<span style='color:#2ecc71; font-weight:bold;'>📥 Kassetter laddade (Kammare 1: 12° CQB | Kammare 2: 3.5° Standoff).</span>"
      });
    } else {
      // Utmatning av kassetter (antingen laddade eller förbrukade)
      const hadFired = (this.chamber1 === ChamberState.FIRED || this.chamber2 === ChamberState.FIRED);
      this.chamber1 = ChamberState.EMPTY;
      this.chamber2 = ChamberState.EMPTY;
      this.activeChamber = 1;
      this.notify('LOG', {
        message: hadFired
          ? "<span style='color:#f39c12; font-weight:bold;'>⏏️ Förbrukade kassetter utkastade. Kammare tomma.</span>"
          : "<span style='color:#bdc3c7; font-weight:bold;'>⏏️ Kassetter utmatade. Kammare tomma.</span>"
      });
    }

    if (!this.isSafe && this.hasBattery) {
      this.displayState = (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY)
        ? 'FUNK_MODE'
        : 'ACTIVE';
    }

    this.notify('CASSETTE_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  /**
   * 2. Osäkra vapnet (utan kassetter i) -> Vapnet går in i "Funk-läge" (Infomeny).
   * 4. Säkra vapnet -> Skärmen stängs av.
   */
  toggleSafety() {
    if (!this.hasBattery) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>Vapnet saknar batteri!</span>" });
      return false;
    }

    // Stop active electrical cycle on safety toggle
    if (this.cycleTimer) {
      this.stopCycle();
    }

    this.isSafe = !this.isSafe;

    if (this.isSafe) {
      // Säkrat vapen: Skärmen stängs av
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }
      if (this.stealthMode) this.stealthMode = false;
      this.displayState = 'OFF';
      this.notify('LOG', { message: 'Vapnet är SÄKRAT. Display avstängd.' });
    } else {
      // Osäkrat vapen:
      // Om kassetter saknas -> FUNK_MODE (Infomeny)
      // Om kassetter finns -> ACTIVE (Skarpt läge)
      if (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY) {
        this.displayState = 'FUNK_MODE';
        this.notify('LOG', { message: "<span style='color:#f1c40f'><b>Vapnet är OSÄKRAT (utan kassetter).</b> Går in i Funktionskontroll (Infomeny).</span>" });
      } else {
        this.displayState = 'ACTIVE';
        this.notify('LOG', { message: "<span style='color:#f1c40f'><b>Vapnet är OSÄKRAT.</b> Skarpt sikte aktiverat.</span>" });
      }
    }

    this.notify('SAFETY_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  tiltWeapon() {
    if (!this.hasBattery || this.isSafe || this.chamber1 === ChamberState.EMPTY) return false;
    this.activeChamber = this.activeChamber === 1 ? 2 : 1;
    this.notify('LOG', { message: `Växlar manuellt till kammare ${this.activeChamber} (${this.activeChamber === 1 ? '12°' : '3.5°'}).` });
    this.notify('CHAMBER_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  setChamber(num) {
    if (!this.hasBattery || this.isSafe || this.chamber1 === ChamberState.EMPTY) return false;
    if (num !== 1 && num !== 2) return false;
    if (this.activeChamber !== num) {
      this.activeChamber = num;
      this.notify('LOG', { message: `Växlar till kammare ${this.activeChamber} (${this.activeChamber === 1 ? '12°' : '3.5°'}).` });
      this.notify('CHAMBER_CHANGED');
      this.notify('DISPLAY_CHANGED');
      return true;
    }
    return false;
  }

  activateStealth() {
    if (!this.hasBattery || !this.isSafe) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>Säkra vapnet</span> för att växla Dolt Läge." });
      return false;
    }
    this.stealthMode = !this.stealthMode;
    if (this.stealthMode) {
      this.notify('LOG', { message: "<span style='color:#9b59b6; font-weight:bold;'>Dolt läge PÅ!</span> (Display och laser dämpade)" });
    } else {
      this.notify('LOG', { message: 'Dolt läge AV.' });
    }
    this.notify('STEALTH_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  toggleClothing() {
    this.heavyClothing = !this.heavyClothing;
    if (this.heavyClothing) {
      this.notify('LOG', { message: "<span style='color:#f1c40f'>Tjocka kläder aktiverade. Risk för disconnect ökad.</span>" });
    } else {
      this.notify('LOG', { message: 'Normala kläder aktiverade.' });
    }
    this.notify('CLOTHING_CHANGED');
    return this.heavyClothing;
  }

  /**
   * 3. Användaren trycker på någon av varningsknapparna -> Varningsbågen testas (visuellt och ljud).
   */
  pressSingleWarning() {
    if (!this.hasBattery || this.isSafe || this.cycleTimer) return false;
    const isFunk = this.displayState === 'FUNK_MODE' || (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY);
    this.startCycle(isFunk ? 'Funktionskontroll: Testar varningsbåge...' : 'Skarp varningsbåge!', 'WARNING_ARC');
    return true;
  }

  pressDualWarning() {
    if (!this.hasBattery || !this.isSafe) return false;
    this.displayState = 'BOOT';
    this.notify('LOG', { message: 'Display (BOOT) aktiv i 3s. Firmware v1.4.10, Batteri 94%.' });
    this.notify('DISPLAY_CHANGED');
    
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = setTimeout(() => {
      if (this.displayState === 'BOOT' && this.isSafe) {
        this.displayState = 'OFF';
        this.notify('DISPLAY_CHANGED');
      }
    }, 3000);
    return true;
  }

  startCycle(msg, type = 'DARTS') {
    if (this.cycleTimer) return false;
    this.cycleType = type;
    this.cycleCount = 1;
    this.displayState = 'CYCLING';
    this.notify('CYCLE_STARTED', { message: msg, type });
    this.notify('DISPLAY_CHANGED');

    this.cycleTimer = setInterval(() => {
      this.cycleCount++;
      if (this.cycleCount > 5) {
        this.stopCycle();
      } else {
        this.notify('CYCLE_TICK', { count: this.cycleCount, type: this.cycleType });
      }
    }, 1000);

    return true;
  }

  stopCycle() {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    const endedType = this.cycleType;
    this.cycleType = null;
    this.cycleCount = 0;

    // Restore state after cycle
    if (this.isSafe) {
      this.displayState = 'OFF';
    } else {
      this.displayState = (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY)
        ? 'FUNK_MODE'
        : 'ACTIVE';
    }

    this.notify('CYCLE_ENDED', { type: endedType });
    this.notify('DISPLAY_CHANGED');
  }

  pressTrigger(fireCallback) {
    if (!this.hasBattery || this.isSafe) {
      this.notify('LOG', { message: 'Kräver osäkrat vapen med batteri.' });
      return { fired: false, reason: 'SAFE_OR_UNPOWERED' };
    }

    if (this.cycleTimer) {
      this.notify('LOG', { message: 'Återaktiverar elström...' });
      return { fired: false, reason: 'ALREADY_CYCLING' };
    }

    const currentChamberState = this.activeChamber === 1 ? this.chamber1 : this.chamber2;
    if (currentChamberState === ChamberState.LOADED) {
      const firedChamber = this.activeChamber;
      if (firedChamber === 1) this.chamber1 = ChamberState.FIRED;
      else this.chamber2 = ChamberState.FIRED;

      this.notify('LOG', {
        message: `<span style='color:red; font-weight:bold;'>💥 SKOTT AVFYRAT (Kammare ${firedChamber} - ${firedChamber === 1 ? '12°' : '3.5°'})</span>`
      });

      let ballisticsResult = null;
      if (typeof fireCallback === 'function') {
        ballisticsResult = fireCallback(firedChamber);
      }

      const nextChamber = firedChamber === 1 ? 2 : 1;
      const nextState = nextChamber === 1 ? this.chamber1 : this.chamber2;
      if (nextState === ChamberState.LOADED) {
        this.activeChamber = nextChamber;
        this.notify('LOG', { message: `Växlar automatiskt till laddad kammare (${this.activeChamber}).` });
      }

      this.notify('DARTS_FIRED', { chamber: firedChamber, ballistics: ballisticsResult });
      this.notify('DISPLAY_CHANGED');
      return { fired: true, chamber: firedChamber, ballistics: ballisticsResult };
    } else if (currentChamberState === ChamberState.FIRED) {
      this.notify('LOG', { message: 'Återaktiverar NMI i befintliga pilar.' });
      this.startCycle('Återaktiverar el...', 'DARTS');
      return { fired: false, reason: 'RE_ENERGIZED' };
    } else {
      this.notify('LOG', { message: 'Tom kammare. (klick)' });
      return { fired: false, reason: 'EMPTY' };
    }
  }

  performKontaktstot() {
    if (this.isSafe || this.cycleTimer) return false;
    this.notify('LOG', { message: "<span style='color:#e67e22; font-weight:bold;'>KONTAKTSTÖT! (Drive Stun)</span>" });
    this.startCycle('NMI påbörjad via Kontaktstöt...', 'DRIVE_STUN');
    return true;
  }

  reset() {
    this.stopCycle();
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    this.chamber1 = ChamberState.EMPTY;
    this.chamber2 = ChamberState.EMPTY;
    this.activeChamber = 1;
    this.displayState = this.isSafe ? 'OFF' : 'FUNK_MODE';
    this.notify('LOG', { message: "♻️ <span style='color:#3498db; font-weight:bold;'>RESET: Vapnet återställt till utgångsläge (tomma kassetter).</span>" });
    this.notify('RESET');
    this.notify('DISPLAY_CHANGED');
  }
}
