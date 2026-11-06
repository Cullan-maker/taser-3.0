/**
 * TASER 7 Finite State Machine (FSM)
 * High-reliability tactical state controller for Axon TASER 7 device.
 */

export const DeviceState = Object.freeze({
  UNPOWERED: 'UNPOWERED',
  SAFE: 'SAFE',
  ARMED: 'ARMED',
  CYCLING: 'CYCLING',
  BOOT: 'BOOT'
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
    this.displayState = 'OFF'; // OFF, BOOT, ACTIVE, FUNK_MODE, CYCLING
    
    // Runtime timers
    this.cycleTimer = null;
    this.cycleCount = 0;
    this.cycleType = null; // 'DARTS' or 'WARNING_ARC' or 'DRIVE_STUN'
    this.bootTimer = null;

    // Listeners
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
    return DeviceState.ARMED;
  }

  getEffectiveAngles() {
    // Chamber 1 = 12 deg (Close Quarter)
    // Chamber 2 = 3.5 deg (Standoff)
    return {
      activeAngle: this.activeChamber === 1 ? 12 : 3.5,
      chamber1Angle: 12,
      chamber2Angle: 3.5
    };
  }

  toggleBattery() {
    if (!this.isSafe) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>FEL: Säkra vapnet innan batteribyte!</span>" });
      return false;
    }

    this.hasBattery = !this.hasBattery;
    if (!this.hasBattery) {
      this.stealthMode = false;
      this.displayState = 'OFF';
      this.notify('LOG', { message: 'Batteri urtaget.' });
    } else {
      this.displayState = 'OFF';
      this.notify('LOG', { message: "<span style='color:#2ecc71'>Batteri isatt. Vapen klart.</span>" });
    }
    this.notify('BATTERY_CHANGED');
    return true;
  }

  toggleCassette() {
    if (!this.isSafe) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>FEL: Säkra vapnet innan kassettbyte!</span>" });
      return false;
    }

    if (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY) {
      this.chamber1 = ChamberState.LOADED;
      this.chamber2 = ChamberState.LOADED;
      this.activeChamber = 1;
      this.notify('LOG', { message: 'Kassetter laddade (12° CQB + 3.5° Standoff).' });
    } else {
      this.chamber1 = ChamberState.EMPTY;
      this.chamber2 = ChamberState.EMPTY;
      this.activeChamber = 1;
      this.notify('LOG', { message: 'Kassetter urtagna.' });
    }
    this.notify('CASSETTE_CHANGED');
    return true;
  }

  toggleSafety() {
    if (this.cycleTimer) return false;
    if (!this.hasBattery) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>Vapnet saknar batteri!</span>" });
      return false;
    }

    this.isSafe = !this.isSafe;
    if (this.isSafe) {
      if (this.stealthMode) this.stealthMode = false;
      this.displayState = 'OFF';
      this.notify('LOG', { message: 'Vapnet är SÄKRAT.' });
    } else {
      this.notify('LOG', { message: "<span style='color:#f1c40f'><b>Vapnet är OSÄKRAT!</b> Sikte aktiverat.</span>" });
      if (this.chamber1 === ChamberState.EMPTY && this.chamber2 === ChamberState.EMPTY) {
        this.notify('LOG', { message: 'Osäkrad utan kassetter (Endast grönt sikte).' });
      }
      this.displayState = this.displayState === 'BOOT' ? 'FUNK_MODE' : 'ACTIVE';
    }
    this.notify('SAFETY_CHANGED');
    return true;
  }

  tiltWeapon() {
    if (!this.hasBattery || this.isSafe || this.chamber1 === ChamberState.EMPTY) return false;
    this.activeChamber = this.activeChamber === 1 ? 2 : 1;
    this.notify('LOG', { message: `Växlar manuellt till kammare ${this.activeChamber} (${this.activeChamber === 1 ? '12°' : '3.5°'}).` });
    this.notify('CHAMBER_CHANGED');
    return true;
  }

  setChamber(num) {
    if (!this.hasBattery || this.isSafe || this.chamber1 === ChamberState.EMPTY) return false;
    if (num !== 1 && num !== 2) return false;
    if (this.activeChamber !== num) {
      this.activeChamber = num;
      this.notify('LOG', { message: `Växlar till kammare ${this.activeChamber} (${this.activeChamber === 1 ? '12°' : '3.5°'}).` });
      this.notify('CHAMBER_CHANGED');
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

  pressSingleWarning() {
    if (!this.hasBattery || this.isSafe || this.cycleTimer) return false;
    const isFunk = this.displayState === 'FUNK_MODE';
    this.startCycle(isFunk ? 'Testar varningsbåge...' : 'Skarp varningsbåge!', 'WARNING_ARC');
    return true;
  }

  pressDualWarning() {
    if (!this.hasBattery || !this.isSafe) return false;
    this.displayState = 'BOOT';
    this.notify('LOG', { message: 'Display (BOOT) aktiv i 5s. Firmware v1.4.10, Batteri 94%.' });
    this.notify('DISPLAY_CHANGED');
    
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = setTimeout(() => {
      if (this.displayState === 'BOOT' && this.isSafe) {
        this.displayState = 'OFF';
        this.notify('DISPLAY_CHANGED');
      }
    }, 5000);
    return true;
  }

  startCycle(msg, type = 'DARTS') {
    if (this.cycleTimer) return false;
    this.cycleType = type;
    this.cycleCount = 1;
    this.notify('CYCLE_STARTED', { message: msg, type });

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
    this.notify('CYCLE_ENDED', { type: endedType });
  }

  pressTrigger(fireCallback) {
    if (!this.hasBattery || this.isSafe) {
      this.notify('LOG', { message: 'Kräver osäkrat vapen med batteri.' });
      return { fired: false, reason: 'SAFE_OR_UNPOWERED' };
    }

    if (this.cycleTimer) {
      // Re-energize cycle
      this.notify('LOG', { message: 'Återaktiverar elström...' });
      return { fired: false, reason: 'ALREADY_CYCLING' };
    }

    const currentChamberState = this.activeChamber === 1 ? this.chamber1 : this.chamber2;
    if (currentChamberState === ChamberState.LOADED) {
      // Discharge dart cartridge
      const firedChamber = this.activeChamber;
      if (firedChamber === 1) this.chamber1 = ChamberState.FIRED;
      else this.chamber2 = ChamberState.FIRED;

      this.notify('LOG', {
        message: `<span style='color:red; font-weight:bold;'>💥 SKOTT AVFYRAT (Kammare ${firedChamber} - ${firedChamber === 1 ? '12°' : '3.5°'})</span>`
      });

      // Execute ballistics callback
      let ballisticsResult = null;
      if (typeof fireCallback === 'function') {
        ballisticsResult = fireCallback(firedChamber);
      }

      // Auto-switch to remaining loaded chamber if available
      const nextChamber = firedChamber === 1 ? 2 : 1;
      const nextState = nextChamber === 1 ? this.chamber1 : this.chamber2;
      if (nextState === ChamberState.LOADED) {
        this.activeChamber = nextChamber;
        this.notify('LOG', { message: `Växlar automatiskt till laddad kammare (${this.activeChamber}).` });
      }

      this.notify('DARTS_FIRED', { chamber: firedChamber, ballistics: ballisticsResult });
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
    this.chamber1 = ChamberState.LOADED;
    this.chamber2 = ChamberState.LOADED;
    this.activeChamber = 1;
    this.displayState = this.isSafe ? 'OFF' : 'ACTIVE';
    this.notify('LOG', { message: "♻️ <span style='color:#3498db; font-weight:bold;'>RESET: Vapnet laddat och återställt.</span>" });
    this.notify('RESET');
  }
}
