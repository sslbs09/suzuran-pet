(() => {
  document.documentElement.classList.add('js');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const header = document.querySelector('[data-header]');
  const progress = document.querySelector('[data-scroll-progress]');
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  const year = document.querySelector('[data-year]');
  const toast = document.querySelector('[data-toast]');

  if (year) year.textContent = String(new Date().getFullYear());

  const setHeader = () => {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 22);
    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      progress.style.width = `${ratio * 100}%`;
    }
  };
  setHeader();
  window.addEventListener('scroll', setHeader, { passive: true });
  window.addEventListener('resize', setHeader, { passive: true });

  const closeNav = () => {
    if (!nav || !navToggle) return;
    nav.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '打开菜单');
    document.body.classList.remove('nav-open');
  };

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const open = navToggle.getAttribute('aria-expanded') === 'true';
      if (open) {
        closeNav();
      } else {
        nav.classList.add('is-open');
        navToggle.setAttribute('aria-expanded', 'true');
        navToggle.setAttribute('aria-label', '关闭菜单');
        document.body.classList.add('nav-open');
      }
    });
    nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeNav();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 960) closeNav();
    });
  }

  /* Reveal content once, without hiding it when JS is unavailable. */
  const revealItems = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    revealItems.forEach((item) => revealObserver.observe(item));
  }

  /* Mark the current chapter in the header. */
  const navLinks = Array.from(document.querySelectorAll('.site-nav a[href^="#"]'));
  const sections = navLinks
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  if ('IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((link) => {
          link.classList.toggle('is-active', link.getAttribute('href') === `#${entry.target.id}`);
        });
      });
    }, { rootMargin: '-28% 0px -60% 0px', threshold: 0 });
    sections.forEach((section) => sectionObserver.observe(section));
  }

  /* Desktop stage: a very light parallax, not a rollercoaster. */
  const stageWrap = document.querySelector('[data-parallax-stage]');
  const stage = stageWrap ? stageWrap.querySelector('.desktop-stage') : null;
  if (stageWrap && stage && !reducedMotion && window.matchMedia('(pointer: fine)').matches) {
    stageWrap.addEventListener('pointermove', (event) => {
      const rect = stageWrap.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      stage.style.setProperty('--tilt-x', `${(-y * 2.4).toFixed(2)}deg`);
      stage.style.setProperty('--tilt-y', `${(x * 3.1).toFixed(2)}deg`);
    });
    stageWrap.addEventListener('pointerleave', () => {
      stage.style.setProperty('--tilt-x', '0deg');
      stage.style.setProperty('--tilt-y', '0deg');
    });
  }

  /* Give the mascot a tiny, tactile response. */
  const heroCharacter = document.querySelector('.hero-character');
  const heartLayer = document.querySelector('[data-heart-layer]');
  const bubbleOne = document.querySelector('.chat-bubble-one');
  const bubbleTwo = document.querySelector('.chat-bubble-two');
  const greetingPairs = [
    ['今天也辛苦了。', '要先喝口水吗？'],
    ['你回来啦。', '我会在这儿。'],
    ['别一直盯着屏幕。', '眨眨眼，休息一下。'],
    ['我没有偷看你。', '只是刚好在。']
  ];
  let greetingIndex = 0;
  let toastTimer = 0;

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 1900);
  };

  const makeHearts = () => {
    if (!heartLayer || !heroCharacter || reducedMotion) return;
    const rect = heroCharacter.getBoundingClientRect();
    for (let index = 0; index < 5; index += 1) {
      const heart = document.createElement('span');
      heart.className = 'heart';
      heart.textContent = index % 2 ? '♥' : '+';
      heart.style.left = `${rect.left + rect.width * (0.32 + Math.random() * 0.36)}px`;
      heart.style.top = `${rect.top + rect.height * (0.24 + Math.random() * 0.24)}px`;
      heart.style.setProperty('--dx', `${(Math.random() - 0.5) * 88}px`);
      heart.style.setProperty('--rot', `${(Math.random() - 0.5) * 70}deg`);
      heart.style.animationDelay = `${index * 0.045}s`;
      heartLayer.appendChild(heart);
      window.setTimeout(() => heart.remove(), 1450);
    }
  };

  if (heroCharacter) {
    heroCharacter.addEventListener('click', () => {
      heroCharacter.classList.remove('is-poked');
      void heroCharacter.offsetWidth;
      heroCharacter.classList.add('is-poked');
      window.setTimeout(() => heroCharacter.classList.remove('is-poked'), 560);
      makeHearts();
      greetingIndex = (greetingIndex + 1) % greetingPairs.length;
      const [first, second] = greetingPairs[greetingIndex];
      if (bubbleOne) bubbleOne.textContent = first;
      if (bubbleTwo) bubbleTwo.textContent = second;
      showToast('她朝你挥了挥手。');
    });
  }

  /* Expression archive: switch real character frames, keep it accessible. */
  const moodImage = document.querySelector('[data-mood-image]');
  const moodIndex = document.querySelector('[data-mood-index]');
  const moodStamp = document.querySelector('[data-mood-stamp]');
  const moodCaption = document.querySelector('[data-mood-caption]');
  const moodButtons = Array.from(document.querySelectorAll('[data-mood]'));
  let moodRequest = 0;

  const preloadMoods = () => {
    moodButtons.forEach((button) => {
      const image = new Image();
      image.src = `assets/${button.dataset.mood}.png`;
    });
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(preloadMoods, { timeout: 2200 });
  } else {
    window.setTimeout(preloadMoods, 1500);
  }

  const selectMood = (button, announce = true) => {
    if (!button || !moodImage) return;
    const { mood, label, caption, alt } = button.dataset;
    moodButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    if (moodIndex) moodIndex.textContent = `${String(moodButtons.indexOf(button) + 1).padStart(2, '0')} / ${String(moodButtons.length).padStart(2, '0')}`;
    if (moodStamp) moodStamp.textContent = label || '';
    if (moodCaption) moodCaption.textContent = caption || '';
    if (announce && toast) showToast(`已切换到「${button.textContent.trim()}」`);

    const request = ++moodRequest;
    const nextSource = `assets/${mood}.png`;
    const preload = new Image();
    const swap = () => {
      if (request !== moodRequest) return;
      moodImage.src = nextSource;
      moodImage.alt = alt || '苏苏洛的角色帧';
      moodImage.classList.remove('is-switching');
    };
    moodImage.classList.add('is-switching');
    preload.onload = () => window.setTimeout(swap, reducedMotion ? 0 : 120);
    preload.onerror = () => {
      if (request === moodRequest) moodImage.classList.remove('is-switching');
      showToast('这张表情暂时没有加载出来。');
    };
    preload.src = nextSource;
  };

  moodButtons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener('click', () => selectMood(button));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + moodButtons.length) % moodButtons.length;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % moodButtons.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = moodButtons.length - 1;
      const next = moodButtons[nextIndex];
      next.focus();
      selectMood(next);
    });
  });

  /* Graceful feedback when an external download link cannot open. */
  document.querySelectorAll('a[target="_blank"]').forEach((link) => {
    link.addEventListener('click', () => {
      showToast('正在打开新页面…');
    });
  });
})();
