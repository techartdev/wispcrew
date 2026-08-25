/**
 * desktop-notify.ts — native notifications, which only a GUI process can raise.
 *
 * The daemon does the unattended work but cannot show a notification: that
 * needs a window server, a session, and on Windows a registered application
 * identity. So the daemon queues, and this drains the queue whenever the app
 * is running.
 *
 * The practical effect is that anything found while the app was closed
 * appears shortly after it opens — not as good as a message to a phone,
 * which is why Telegram exists, but honest and free.
 */
import { app, BrowserWindow, Notification } from 'electron';
import { drain, fileLog, type ChannelDeliverer } from '@ghostbot/runtime';

/** How often to look for messages the daemon left for us. */
const DRAIN_INTERVAL_MS = 20_000;

/**
 * Raise a native notification.
 *
 * Returns false rather than throwing when the platform cannot show one, so
 * the message stays queued for a machine that can — a headless CI run should
 * not silently consume a user's notification.
 */
function desktopChannel(): ChannelDeliverer {
  return {
    id: 'desktop',
    async deliver(message) {
      if (!Notification.isSupported()) return false;

      const notification = new Notification({
        title: message.agentName,
        body: message.summary,
        // Quiet by default: an agent reporting hourly should not make a
        // sound every time.
        silent: false,
      });

      notification.on('click', () => {
        // Bring the conversation to them rather than just the app: the point
        // of the notification is what the agent said.
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send('gb:event', {
            type: 'notice',
            level: 'info',
            text: `${message.agentName}: ${message.summary}`,
          });
        }
      });

      notification.show();
      return true;
    },
  };
}

/**
 * Deliver queued notifications while the app is running.
 *
 * Polling rather than watching the file: the interval is long, the file is
 * small, and a watcher would add a platform-specific dependency to catch
 * events that are never urgent by more than a few seconds.
 */
export function startDesktopNotifications(dataDir: string): () => void {
  const deliverers = [desktopChannel()];

  const tick = () => {
    void drain(dataDir, deliverers).catch((err: Error) =>
      fileLog('[desktop-notify] drain failed', err.message),
    );
  };

  // Once at startup, so anything found while the app was closed appears
  // promptly rather than after a full interval.
  tick();

  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
  // Never a reason to keep the process alive; quitting should not wait for
  // a notification poll.
  timer.unref?.();

  app.on('before-quit', () => clearInterval(timer));
  return () => clearInterval(timer);
}
