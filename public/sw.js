self.addEventListener('message', (event) => {
  const [port] = event.ports;
  if (port && event.source) port.postMessage(event.source.id);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { client: id, click } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const owner = id ? await self.clients.get(id) : undefined;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = owner ?? windows[0];
      if (!client) return self.clients.openWindow('/');
      await client.focus();
      if (client === owner) client.postMessage({ type: 'nod:notification-click', click });
    })(),
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.some((client) => client.focused && client.visibilityState === 'visible')) return;
      return self.registration.showNotification('Nod', {
        body: 'Nod has a new reply for you.',
        icon: '/nod-logo.png',
        tag: 'nod-reply',
        renotify: true,
      });
    }),
  );
});
