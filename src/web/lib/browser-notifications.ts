import type { Message, Preferences } from '../../shared/contracts';
import { desktopSettingsAvailable } from './desktop';
import { captureAnalytics } from './analytics';
import { api } from './api';

const changed = 'nod:browser-notifications';
const invalidatedChoices = new Set<string>();
const preferenceKey = (ownerId: string) => `nod.browser-notifications.${ownerId}`;
const foregroundKey = (ownerId: string) => `nod.browser-notifications.foreground.${ownerId}`;

export function browserNotificationStatus(ownerId: string) {
  const available =
    !desktopSettingsAvailable() &&
    window.isSecureContext &&
    typeof window.navigator.locks?.request === 'function' &&
    typeof window.Notification === 'function';
  let choice: string | null = null;
  try {
    choice = window.localStorage.getItem(preferenceKey(ownerId));
  } catch {}
  if (choice === 'enabled' && invalidatedChoices.has(ownerId)) choice = 'disabled';
  const permission = available ? window.Notification.permission : 'default';
  return {
    available,
    permission,
    choice,
    enabled: available && choice === 'enabled' && permission === 'granted',
  };
}

function saveChoice(ownerId: string, value: string) {
  window.localStorage.setItem(preferenceKey(ownerId), value);
  invalidatedChoices.delete(ownerId);
  window.dispatchEvent(new Event(changed));
}

export function subscribeBrowserNotifications(
  ownerId: string,
  listener: (revoked: boolean) => void,
) {
  const update = (event?: Event) => {
    const storage = event?.type === 'storage' ? (event as StorageEvent) : undefined;
    const owned = storage && (storage.key === preferenceKey(ownerId) || storage.key === null);
    const status = browserNotificationStatus(ownerId);
    if (
      !desktopSettingsAvailable() &&
      status.choice === 'enabled' &&
      status.permission !== 'granted'
    ) {
      invalidatedChoices.add(ownerId);
      try {
        saveChoice(ownerId, 'disabled');
      } catch {
        window.dispatchEvent(new Event(changed));
      }
      return;
    }
    listener(Boolean(owned && storage.newValue !== 'enabled'));
  };
  window.addEventListener(changed, update);
  window.addEventListener('storage', update);
  window.addEventListener('focus', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener('storage', update);
    window.removeEventListener('focus', update);
    document.removeEventListener('visibilitychange', update);
  };
}

export function watchBrowserNotificationFocus(ownerId: string) {
  const locks = window.navigator.locks;
  if (!locks || desktopSettingsAvailable()) return () => {};
  let controller: AbortController | undefined;
  let release: (() => void) | undefined;
  const clear = () => {
    controller?.abort();
    release?.();
    release = undefined;
  };
  const update = () => {
    clear();
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const request = new AbortController();
    controller = request;
    void locks
      .request(foregroundKey(ownerId), { signal: request.signal }, () => {
        if (request.signal.aborted) return;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {});
  };
  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', update);
  return () => {
    clear();
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    window.removeEventListener('pagehide', clear);
    document.removeEventListener('visibilitychange', update);
  };
}

const clickHandlers = new Map<string, { click: string; run: () => void }>();
let worker:
  Promise<{ registration: ServiceWorkerRegistration; client: string } | undefined> | undefined;

function notificationWorker() {
  worker ??= (async () => {
    if (!('serviceWorker' in window.navigator)) return undefined;
    try {
      const container = window.navigator.serviceWorker;
      container.addEventListener('message', (event: MessageEvent) => {
        const data: unknown = event.data;
        if (!data || typeof data !== 'object' || !('click' in data)) return;
        const entry = [...clickHandlers].find(([, handler]) => handler.click === data.click);
        if (!entry) return;
        clickHandlers.delete(entry[0]);
        entry[1].run();
      });
      await container.register('/sw.js');
      const registration = await container.ready;
      const active = registration.active;
      if (!active) return undefined;
      const client = await new Promise<string>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event: MessageEvent) => resolve(String(event.data));
        active.postMessage(null, [channel.port2]);
      });
      return { registration, client };
    } catch {
      return undefined;
    }
  })();
  return worker;
}

const pushKey = 'nod.browser-push';
let pushSync = Promise.resolve(false);

async function pushSubscription(create: boolean) {
  if (!('PushManager' in window) || !/Android/i.test(window.navigator.userAgent)) return null;
  const fallback = await notificationWorker();
  if (!fallback) return null;
  const manager = fallback.registration.pushManager;
  const existing = await manager.getSubscription();
  if (!create) return existing;
  const { publicKey } = await api<{ publicKey: string }>('/api/push');
  const key = existing?.options.applicationServerKey;
  if (
    existing &&
    key &&
    btoa(String.fromCharCode(...new Uint8Array(key)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') === publicKey
  )
    return existing;
  await existing?.unsubscribe();
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
}

async function pushRegistered() {
  const subscription = await pushSubscription(false).catch(() => null);
  return !!subscription && window.localStorage.getItem(pushKey) === subscription.endpoint;
}

export function syncBrowserPush(enabled: () => boolean) {
  pushSync = pushSync
    .catch(() => false)
    .then(async () => {
      const subscription = await pushSubscription(enabled()).catch(() => null);
      if (!subscription) return false;
      const body = JSON.stringify({ endpoint: subscription.endpoint });
      if (enabled()) {
        await api('/api/push', { method: 'PUT', body });
        if (!enabled()) return false;
        window.localStorage.setItem(pushKey, subscription.endpoint);
        return true;
      }
      window.localStorage.removeItem(pushKey);
      await api('/api/push', { method: 'DELETE', body }).catch(() => {});
      await subscription.unsubscribe();
      return false;
    });
  return pushSync;
}

async function showNotification(
  tag: string,
  body: string,
  keep: () => boolean,
  onclick?: () => void,
) {
  const options = {
    silent: true,
    body,
    icon: new URL('/nod-logo.png', window.location.origin).href,
    tag,
  };
  try {
    const notification = new window.Notification('Nod', options);
    notification.onshow = () => {
      if (!keep()) notification.close();
    };
    if (onclick)
      notification.onclick = () => {
        notification.close();
        onclick();
      };
    return notification;
  } catch (error) {
    const fallback = await notificationWorker();
    if (!fallback) throw error;
    if (!keep()) return undefined;
    const click = window.crypto.randomUUID();
    if (onclick) clickHandlers.set(tag, { click, run: onclick });
    else clickHandlers.delete(tag);
    const shown = await fallback.registration
      .showNotification('Nod', { ...options, data: { click, client: fallback.client } })
      .then(() => fallback.registration.getNotifications({ tag }))
      .then(([notification]) => notification)
      .catch(() => undefined);
    if (!shown || !keep()) {
      if (clickHandlers.get(tag)?.click === click) clickHandlers.delete(tag);
      shown?.close();
      if (!shown) throw error;
      return undefined;
    }
    return shown;
  }
}

export async function setBrowserNotifications(
  ownerId: string,
  enabled: boolean,
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent() || desktopSettingsAvailable()) return;
  if (!enabled) {
    saveChoice(ownerId, 'disabled');
    return void syncBrowserPush(() => false).catch(() => {});
  }
  const status = browserNotificationStatus(ownerId);
  if (!status.available) throw new Error('Browser notifications are unavailable here.');
  const permission =
    status.permission === 'default'
      ? await window.Notification.requestPermission()
      : status.permission;
  if (!isCurrent() || desktopSettingsAvailable()) return;
  if (permission !== 'granted') {
    window.dispatchEvent(new Event(changed));
    throw new Error(
      permission === 'denied'
        ? 'Allow notifications for this site in your browser settings to enable them.'
        : 'Notifications remain off. You can enable them when you are ready.',
    );
  }
  const key = preferenceKey(ownerId);
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, 'enabled');
  let notification;
  try {
    notification = await showNotification(
      key,
      'Notifications are on.',
      () => isCurrent() && browserNotificationStatus(ownerId).enabled,
    );
  } catch {
    if (window.localStorage.getItem(key) === 'enabled') {
      if (previous === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, previous === 'enabled' ? 'disabled' : previous);
    }
    window.dispatchEvent(new Event(changed));
    throw new Error('This browser cannot show notifications here. Use Nod’s desktop app.');
  }
  invalidatedChoices.delete(ownerId);
  window.dispatchEvent(new Event(changed));
  void syncBrowserPush(() => browserNotificationStatus(ownerId).enabled).catch(() => {});
  return notification;
}

export function dismissBrowserNotifications(ownerId: string) {
  if (!desktopSettingsAvailable()) saveChoice(ownerId, 'dismissed');
}

export function browserNotificationQuietTime(preferences: Preferences, now = new Date()) {
  if (!preferences.quietHoursEnabled) return false;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const { quietStart, quietEnd } = preferences;
  return (
    quietStart !== quietEnd &&
    (quietStart < quietEnd
      ? current >= quietStart && current < quietEnd
      : current >= quietStart || current < quietEnd)
  );
}

export async function deliverBrowserNotification(
  ownerId: string,
  threadId: string,
  message: Pick<Message, 'id' | 'createdAt'>,
  isCurrent: () => boolean,
  canDeliver: () => boolean = () => true,
) {
  if (await pushRegistered()) return null;
  const key = `nod.browser-notifications.last.${JSON.stringify([ownerId, threadId])}`;
  const eligible = () =>
    isCurrent() &&
    canDeliver() &&
    browserNotificationStatus(ownerId).enabled &&
    !(document.visibilityState === 'visible' && document.hasFocus());
  const deliver = () => {
    if (!eligible()) return null;
    let previous: { createdAt: string; ids: string[] } | null = null;
    try {
      previous = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    } catch {}
    const ids =
      previous?.createdAt === message.createdAt && Array.isArray(previous.ids) ? previous.ids : [];
    if ((previous && previous.createdAt > message.createdAt) || ids.includes(message.id))
      return null;
    window.localStorage.setItem(
      key,
      JSON.stringify({ createdAt: message.createdAt, ids: [...ids, message.id] }),
    );
    return showNotification(key, 'Nod has a new reply for you.', eligible, () => {
      if (!isCurrent()) return;
      window.focus();
      captureAnalytics('notification_opened', { kind: 'reply' });
      window.dispatchEvent(
        new CustomEvent('nod:focus-message', { detail: { messageId: message.id } }),
      );
    });
  };
  const locks = window.navigator.locks;
  if (!locks) return null;
  return locks.request(key, () =>
    locks.request(foregroundKey(ownerId), { ifAvailable: true }, (lock) =>
      lock ? deliver() : null,
    ),
  );
}
