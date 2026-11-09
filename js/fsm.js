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
    this.isFunkLocked = false; // Latching State för Funktionskontroll
    
    // Procedural training vs Tactical Scenario phase
    this.isScenarioActive = false;

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
    if (this.isFunkLocked || this.displayState === 'FUNK_MODE') return DeviceState.FUNK_MODE;
    if (this.isSafe) return DeviceState.SAFE;
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
      this.isFunkLocked = false;
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
            this.displayState = 'ACTIVE';
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

    if (this.isFunkLocked) {
      this.displayState = 'FUNK_MODE';
    } else if (!this.isSafe && this.hasBattery) {
      this.displayState = 'ACTIVE';
    }

    this.notify('CASSETTE_CHANGED');
    this.notify('DISPLAY_CHANGED');
    return true;
  }

  /**
   * 2. Osäkra vapnet -> Vapnet går till ACTIVE (skarpt läge med sikte och svart OLED-display).
   * 4. Säkra vapnet -> Skärmen stängs av.
   * Urstigning ur låst funktionskontroll sker ENDAST via säkringsknappen!
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

    // Säkringsknappen är den ENDA interaktionen som bryter ett låst Funktionskontroll-läge
    const wasFunkLocked = this.isFunkLocked;
    this.isFunkLocked = false;

    this.isSafe = !this.isSafe;

    if (this.isSafe) {
      // Säkrat vapen: Skärmen stängs av
      if (this.bootTimer) {
        clearTimeout(this.bootTimer);
        this.bootTimer = null;
      }
      if (this.stealthMode) this.stealthMode = false;
      this.displayState = 'OFF';
      this.notify('LOG', {
        message: wasFunkLocked
          ? 'Funktionskontroll avslutad. Vapnet är SÄKRAT (display släckt).'
          : 'Vapnet är SÄKRAT. Display avstängd.'
      });
    } else {
      // Osäkrat vapen: Går ALLTID till ACTIVE (skarpt läge med svart OLED-bakgrund)
      this.displayState = 'ACTIVE';
      this.notify('LOG', { message: "<span style='color:#f1c40f'><b>Vapnet är OSÄKRAT.</b> Skarpt sikte aktiverat.</span>" });
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

  startScenario() {
    this.isScenarioActive = true;
    this.notify('SCENARIO_CHANGED', { isScenarioActive: true });
    this.notify('LOG', {
      message: "<span style='color:#e74c3c; font-weight:bold;'>🚨 SCENARIOFAS AKTIVERAD:</span> Angriparen agerar! Vapnet ska vara laddat och klart."
    });
    return true;
  }

  stopScenario() {
    this.isScenarioActive = false;
    this.notify('SCENARIO_CHANGED', { isScenarioActive: false });
    this.notify('LOG', {
      message: "<span style='color:#3498db; font-weight:bold;'>🛠️ PROCEDURFAS:</span> Hotet fryst i Idle. Öva laddning, kassetter och funktionskontroll i lugn och ro."
    });
    return true;
  }

  /**
   * 3. Användaren trycker på någon av varningsknapparna -> Varningsbågen testas (visuellt och ljud).
   */
  pressSingleWarning() {
    if (!this.hasBattery || this.cycleTimer) return false;
    // Tillåt varningsbåge om vapnet är osäkrat ELLER i låst funktionskontroll
    if (this.isSafe && !this.isFunkLocked && this.displayState !== 'FUNK_MODE') return false;

    const isFunk = this.isFunkLocked || this.displayState === 'FUNK_MODE';
    this.startCycle(isFunk ? 'Funktionskontroll: Testar varningsbåge...' : 'Skarp varningsbåge!', 'WARNING_ARC');
    return true;
  }

  pressDualWarning() {
    if (!this.hasBattery) {
      this.notify('LOG', { message: "<span style='color:#e74c3c'>Sätt i batteri för att utföra funktionskontroll.</span>" });
      return false;
    }

    if (this.cycleTimer) return false;

    // Lås tillståndet i Funktionskontroll (Latching State)
    this.isFunkLocked = true;
    this.displayState = 'FUNK_MODE';

    // Rensa eventuell bootTimer - INGEN timeout får någonsin släcka funktionskontrollen!
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }

    this.notify('LOG', {
      message: "<span style='color:#f1c40f; font-weight:bold;'>⚠️ FUNKTIONSKONTROLL AKTIVERAD:</span> Displayen är låst i gult läge med svarta ikoner. Testar varningsbåge..."
    });
    this.notify('DISPLAY_CHANGED');
    this.startCycle('Funktionskontroll: Testar varningsbåge...', 'WARNING_ARC');
    return true;
  }

  startCycle(msg, type = 'DARTS') {
    if (this.cycleTimer) return false;
    this.cycleType = type;
    this.cycleCount = 1;
    const isFunk = this.isFunkLocked || this.displayState === 'FUNK_MODE';
    this.displayState = 'CYCLING';
    this.notify('CYCLE_STARTED', { message: msg, type, isFunk });
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

    // Återställ tillstånd efter cykel - låst Funktionskontroll förblir aktivt!
    if (this.isFunkLocked) {
      this.displayState = 'FUNK_MODE';
    } else if (this.isSafe) {
      this.displayState = 'OFF';
    } else {
      this.displayState = 'ACTIVE';
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
    this.isFunkLocked = false;
    this.chamber1 = ChamberState.EMPTY;
    this.chamber2 = ChamberState.EMPTY;
    this.activeChamber = 1;
    this.displayState = this.isSafe ? 'OFF' : 'ACTIVE';
    this.notify('LOG', { message: "♻️ <span style='color:#3498db; font-weight:bold;'>RESET: Vapnet återställt till utgångsläge (tomma kassetter).</span>" });
    this.notify('RESET');
    this.notify('DISPLAY_CHANGED');
  }
}
