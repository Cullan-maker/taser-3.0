/**
 * TASER 7 PWA & Offline Service Controller
 * Provides service worker lifecycle management, in-app install prompts, and offline alerts.
 */

export class TaserPWA {
  constructor(options = {}) {
    this.options = options;
    this.deferredPrompt = null;
    this.isInstalled = false;
    this.isIOS = false;
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

    this.init();
  }

  init() {
    // Detect standalone mode (already running as PWA)
    if (typeof window !== 'undefined') {
      this.isInstalled =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;

      const ua = window.navigator.userAgent.toLowerCase();
      this.isIOS = /iphone|ipad|ipod/.test(ua);

      // Listen for install prompt
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredPrompt = e;
        this.updateUI();
      });

      window.addEventListener('appinstalled', () => {
        this.isInstalled = true;
        this.deferredPrompt = null;
        this.updateUI();
        console.log('[TaserPWA] App installed successfully');
      });

      // Network status
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.updateNetworkBadge();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
        this.updateNetworkBadge();
      });

      // Register Service Worker
      this.registerServiceWorker();
      this.updateUI();
      this.updateNetworkBadge();
    }
  }

  async registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.log('[TaserPWA] Service Worker registered with scope:', reg.scope);
      } catch (err) {
        console.warn('[TaserPWA] Service Worker registration failed:', err);
      }
    }
  }

  async promptInstall() {
    if (this.deferredPrompt) {
      this.deferredPrompt.prompt();
      const choice = await this.deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        this.isInstalled = true;
        this.deferredPrompt = null;
      }
      this.updateUI();
      return choice.outcome === 'accepted';
    } else if (this.isIOS) {
      // Show iOS modal guide
      const modal = document.getElementById('ios-install-modal');
      if (modal) modal.style.display = 'flex';
      return false;
    }
    return false;
  }

  updateUI() {
    const installBtn = document.getElementById('btn-pwa-install');
    if (!installBtn) return;

    if (this.isInstalled) {
      installBtn.style.display = 'none';
      return;
    }

    if (this.deferredPrompt) {
      installBtn.style.display = 'inline-flex';
      installBtn.innerHTML = '📥 Installera App';
    } else if (this.isIOS) {
      installBtn.style.display = 'inline-flex';
      installBtn.innerHTML = '📲 Installera (iOS)';
    } else {
      installBtn.style.display = 'none';
    }
  }

  updateNetworkBadge() {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;

    if (!this.isOnline) {
      badge.style.display = 'flex';
      badge.textContent = '⚡ FÄLTLÄGE: 100% OFFLINE';
    } else {
      badge.style.display = 'none';
    }
  }
}
