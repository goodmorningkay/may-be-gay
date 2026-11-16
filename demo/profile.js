const discordButton = document.getElementById('discord-copy');
const discordName = document.getElementById('discord-name').textContent;
const feedback = document.getElementById('copy-feedback');
let feedbackTimer;
let copyAttempt = 0;

function clearFeedback() {
  copyAttempt += 1;
  clearTimeout(feedbackTimer);
  feedback.textContent = '';
}

discordButton.addEventListener('pointerleave', clearFeedback);
discordButton.addEventListener('blur', clearFeedback);

discordButton.addEventListener('click', async () => {
  clearFeedback();
  const attempt = copyAttempt;
  let message;
  try {
    await navigator.clipboard.writeText(discordName);
    message = ' · Copied';
  } catch {
    message = ' · Copy failed';
  }

  if (attempt !== copyAttempt) return;
  feedback.textContent = message;
  feedbackTimer = setTimeout(clearFeedback, 2500);
});

function moveGallery(gallery, index, step) {
  const images = [...gallery.querySelectorAll('.gallery-images img')];
  const next = (index + step + images.length) % images.length;
  const outgoing = images[index];
  const incoming = images[next];
  for (const image of images) {
    for (const animation of image.getAnimations()) animation.cancel();
    image.hidden = image !== incoming;
    image.setAttribute('aria-hidden', String(image !== incoming));
  }

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    outgoing.hidden = false;
    const duration = { duration: 220, easing: 'ease-out' };
    outgoing.animate([{ translate: '0' }, { translate: `${-step * 100}%` }], duration).onfinish = () => {
      outgoing.hidden = true;
    };
    incoming.animate([{ translate: `${step * 100}%` }, { translate: '0' }], duration);
  }

  gallery.querySelector('.gallery-position').textContent = `${next + 1} of ${images.length}`;
  return next;
}

const gallery = document.querySelector('.gallery');
const galleryImages = [...gallery.querySelectorAll('img')];
let activeImage = 0;

for (const button of gallery.querySelectorAll('[data-step]')) {
  button.addEventListener('click', () => {
    activeImage = moveGallery(gallery, activeImage, Number(button.dataset.step));
  });
}

const preview = document.querySelector('.image-preview');
const previewGallery = preview.querySelector('.preview-gallery');
const previewArrows = previewGallery.querySelectorAll('[data-step]');
let previewIndex = 0;
let pointerStartedOnBackdrop = false;

function isBackdrop(event) {
  if (event.target !== preview) return false;
  const { left, right, top, bottom } = preview.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

preview.addEventListener('pointerdown', (event) => {
  pointerStartedOnBackdrop = isBackdrop(event);
});

preview.addEventListener('click', (event) => {
  if (pointerStartedOnBackdrop && isBackdrop(event)) preview.close();
});

function openPreview(images, index) {
  previewIndex = index;
  pointerStartedOnBackdrop = false;
  const slides = images.map((image, position) => {
    const slide = image.cloneNode();
    slide.loading = 'eager';
    slide.hidden = position !== index;
    slide.setAttribute('aria-hidden', String(slide.hidden));
    return slide;
  });
  previewGallery.querySelector('.gallery-images').replaceChildren(...slides);
  for (const arrow of previewArrows) arrow.hidden = slides.length === 1;
  previewGallery.querySelector('.gallery-position').textContent = slides.length > 1 ? `${index + 1} of ${slides.length}` : '';
  preview.showModal();
}

gallery.querySelector('.image-open').addEventListener('click', () => openPreview(galleryImages, activeImage));
const standalone = document.querySelector('.image-card .image-open');
standalone.addEventListener('click', () => openPreview([standalone.querySelector('img')], 0));
document.querySelectorAll('.thumbnails button').forEach((button, index) => {
  button.addEventListener('click', () => openPreview(galleryImages, index));
});

for (const button of previewArrows) {
  button.addEventListener('click', () => {
    previewIndex = moveGallery(previewGallery, previewIndex, Number(button.dataset.step));
  });
}

preview.addEventListener('keydown', (event) => {
  const arrow = event.key === 'ArrowLeft' ? previewArrows[0] : event.key === 'ArrowRight' ? previewArrows[1] : null;
  if (!arrow || arrow.hidden) return;
  event.preventDefault();
  arrow.click();
});
