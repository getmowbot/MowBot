const pad = (n: number) => String(n).padStart(2, '0');

/** "18:42", or "jeu. 18:42" when it is not today (Hermes may lack Intl: plain fallback). */
export function untilLabel(iso: string, language: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  try {
    return date.toLocaleString(language, {
      ...(sameDay ? {} : { weekday: 'short' }),
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return sameDay ? time : `${date.toISOString().slice(0, 10)} ${time}`;
  }
}
