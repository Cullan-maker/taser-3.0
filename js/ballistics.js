/**
 * TASER 7 Ballistic & Zone Evaluation Engine
 * Preserves high-fidelity ballistics, dual-angle dart trajectories, and wire physics.
 */

export class TaserBallistics {
  constructor() {
    this.baseCalibrationDistance = 3.0; // meters
  }

  calculateSpread(distance, chamber = 1) {
    const safeDist = Math.max(0.5, parseFloat(distance) || 3.0);
    const angleDeg = chamber === 1 ? 12 : 3.5;
    const angleRad = (angleDeg * Math.PI) / 180;
    const spreadMeters = safeDist * Math.tan(angleRad);
    const spreadCm = spreadMeters * 100;

    // Visual drop on screen calculation
    const baseScale = 0.5;
    let scaleFactor = (3.0 / safeDist) * baseScale;
    scaleFactor = Math.min(Math.max(scaleFactor, 0.1), 5.0);

    const basePixelDrop = chamber === 1 ? 141.7 : 40.7;
    const visualDropPx = Math.min(basePixelDrop * scaleFactor, 140);

    return {
      distanceMeters: safeDist,
      angleDeg,
      spreadMeters,
      spreadCm,
      visualDropPx
    };
  }

  /**
   * Dynamic Live-AI HUD spread in pixels:
   * Scales continuously and monotonically with measured distance (farther target => larger spread)
   * and matches weapon chamber divergence angle (12° vs 3.5°).
   */
  calculateLiveSpreadPx(distance, chamber = 1, viewportHeight = 760) {
    const safeDist = Math.max(0.5, Math.min(8.5, parseFloat(distance) || 3.0));
    const angleDeg = chamber === 1 ? 12 : 3.5;
    const angleRad = (angleDeg * Math.PI) / 180;
    const spreadMeters = safeDist * Math.tan(angleRad);
    const vpH = Math.max(240, Number(viewportHeight) || 760);
    const vpScale = Math.max(0.7, Math.min(1.3, vpH / 760));

    // At 1.0m: C1 ~38px / C2 ~21px; at 3.0m: C1 ~87px / C2 ~35px; at 6.0m: C1 ~161px / C2 ~56px
    const rawPx = (14 + spreadMeters * 115) * vpScale;
    return Math.min(Math.max(rawPx, 14), vpH * 0.36);
  }

  calculateNdcCoordinates(distance, chamber, viewportHeight = 320, tiltDeg = 0, viewportWidth = viewportHeight) {
    const spreadInfo = this.calculateSpread(distance, chamber);
    const ndc1 = { x: 0, y: 0 }; // Top dart aligned with central aim

    // Gravity ballistic drop on distances > 3.0m
    const safeDist = spreadInfo.distanceMeters;
    const ballisticDrop = safeDist > 3.0 ? Math.pow(safeDist - 3.0, 2) * 0.002 : 0;
    const totalDropNdcY = (spreadInfo.visualDropPx / (viewportHeight / 2)) + ballisticDrop;

    const tiltRad = ((Number(tiltDeg) || 0) * Math.PI) / 180;
    const aspectRatio = (viewportHeight > 0 && viewportWidth > 0) ? (viewportHeight / viewportWidth) : 1;

    const ndc2 = {
      x: -Math.sin(tiltRad) * totalDropNdcY * aspectRatio,
      y: -Math.cos(tiltRad) * totalDropNdcY
    };

    return { ndc1, ndc2, spreadInfo, ballisticDrop };
  }

  evaluateHit({
    hit1,
    hit2,
    hitWall1 = false,
    hitWall2 = false,
    currentDistance = 3.0,
    heavyClothing = false,
    isLiveAR = false,
    ballisticSpreadCm = null
  }) {
    // Both probes must strike the target
    if (!hit1 || !hit2) {
      return {
        success: false,
        reason: 'En eller båda pilarna missade målet.',
        spreadCm: null,
        isZoneFailure: false
      };
    }

    if (hitWall1 || hitWall2) {
      return {
        success: false,
        reason: 'En eller båda pilarna missade kroppen (Vägg/Golv).',
        spreadCm: null,
        isZoneFailure: false
      };
    }

    // Distance between probe entry points on the 3D model or calibrated Live AR spread
    const distMeters = hit1.point.distanceTo(hit2.point);
    const rawSpreadCm = distMeters * 100;
    const spreadCm = isLiveAR
      ? Math.max(rawSpreadCm, Number(ballisticSpreadCm) || 0)
      : rawSpreadCm;

    // Forbidden Zone Check
    let badZone = null;
    const obj1Name = hit1.object ? hit1.object.name : '';
    const obj2Name = hit2.object ? hit2.object.name : '';

    if (obj1Name !== 'Godkand_Zon') badZone = obj1Name;
    if (obj2Name !== 'Godkand_Zon') badZone = obj2Name;

    if (badZone) {
      return {
        success: false,
        reason: `Träff i förbjuden zon (${badZone}).`,
        spreadCm,
        isZoneFailure: true
      };
    }

    // Minimum Spread Threshold
    // I Live AR tillåts närstridshåll (1.0 - 2.0 m) i grön zon med sänkt gränsvärde (minst 3.0 cm)
    let minSpreadCm = isLiveAR ? 3.0 : 20.0;
    if (!isLiveAR) {
      if (currentDistance > 7.0) {
        minSpreadCm = 20.0 + (currentDistance - 7.0) * 2;
      } else if (currentDistance < 2.0) {
        minSpreadCm = 15.0;
      }
    }

    if (spreadCm < minSpreadCm) {
      return {
        success: false,
        reason: `För tät spridning (${spreadCm.toFixed(1)} cm). Krävs minst ${minSpreadCm.toFixed(1)} cm för NMI.`,
        spreadCm,
        isZoneFailure: false
      };
    }

    // Heavy clothing impedance resistance check (endast i 3D-läge)
    if (!isLiveAR && heavyClothing && Math.random() > 0.8) {
      return {
        success: false,
        reason: 'DISCONNECT: Tjocka kläder blockerar elektrisk krets.',
        spreadCm,
        isZoneFailure: false
      };
    }

    return {
      success: true,
      reason: 'Träff i godkänd zon. Full NMI uppnådd.',
      spreadCm,
      isZoneFailure: false
    };
  }
}
