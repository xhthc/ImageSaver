(() => {
  'use strict';
  const demoButton = document.getElementById('demo-save');
  const demoAction = document.getElementById('demo-action');
  const demoResult = document.getElementById('demo-result');
  const resultTitle = document.getElementById('demo-result-title');
  const resultDetail = document.getElementById('demo-result-detail');
  const resultIcon = demoResult.querySelector('use');
  let demoCompleted = false;

  demoButton.addEventListener('click', () => {
    if (demoCompleted) {
      demoCompleted = false;
      demoAction.textContent = 'MediaLatch: Save media';
      resultTitle.textContent = 'Готово к сохранению';
      resultDetail.textContent = 'Фотография · демонстрация';
      resultIcon.setAttribute('href', '#image');
      demoResult.classList.remove('is-saved');
      return;
    }
    demoButton.disabled = true;
    demoAction.textContent = 'Поиск оригинала…';
    resultTitle.textContent = 'Проверяем источник';
    resultDetail.textContent = 'Демонстрация действия расширения';
    window.setTimeout(() => {
      demoCompleted = true;
      demoButton.disabled = false;
      demoAction.textContent = 'Сбросить пример';
      resultTitle.textContent = 'Оригинал сохранён — пример';
      resultDetail.textContent = 'Downloads / SavedImages / alpine.png';
      resultIcon.setAttribute('href', '#check');
      demoResult.classList.add('is-saved');
    }, 700);
  });

  document.getElementById('copy-address').addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText('chrome://extensions');
      status.textContent = 'Адрес скопирован. Вставьте его в новую вкладку.';
    } catch {
      status.textContent = 'Скопируйте вручную: chrome://extensions';
    }
  });
})();
