import { app } from 'spectrum-ts';

/** Launch the Messages app on tap; the conversation bubble should remain a preview. */
export function gameCard(url: string, title = 'Play with a friend') {
  return app(url, { live: false, layout: {
    caption: title, subcaption: 'Tap to play in Messages', summary: `${title} · Two-player game`,
  } });
}
