/* Runs on every page: marks the active nav link and pings /api/health
   for the status chip in the navbar. */
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;
    document.querySelectorAll('.robotik-link').forEach((link) => {
      if (link.dataset.page === page) link.classList.add('active');
    });

    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusLabel');
    if (!dot || !label) return;

    BhunesAPI.health()
      .then(() => {
        dot.classList.remove('pending', 'offline');
        dot.classList.add('online');
        label.textContent = 'API online';
      })
      .catch(() => {
        dot.classList.remove('pending', 'online');
        dot.classList.add('offline');
        label.textContent = 'API unreachable';
      });
  });
})();
