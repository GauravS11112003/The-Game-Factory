/** Reveal each game once as it enters view, including cards loaded later. */
export function arcadeMotion(): { watch: (grid: HTMLElement) => void; dispose: () => void } {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const seen = new Set<string>();
  let refresh: Animation | undefined;
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target as HTMLElement;
      observer?.unobserve(card);
      if (reduced.matches || seen.has(card.dataset.motionKey!)) continue;
      seen.add(card.dataset.motionKey!);
      card.classList.add('ar-card-arrive');
    }
  }, { threshold: .08 });
  const stop = (): void => { refresh?.cancel(); observer?.disconnect(); };
  reduced.addEventListener('change', stop);
  return {
    watch(grid) {
      observer?.disconnect();
      refresh?.cancel();
      if (reduced.matches) return;
      refresh = grid.animate([{ opacity: .65 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      grid.querySelectorAll<HTMLElement>('.ar-game-card').forEach((card, index) => {
        card.style.setProperty('--card-delay', `${index % 3 * 55}ms`);
        if (!seen.has(card.dataset.motionKey!)) observer?.observe(card);
      });
    },
    dispose() { stop(); reduced.removeEventListener('change', stop); },
  };
}
