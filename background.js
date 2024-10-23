chrome.action.onClicked.addListener((tab) => {
  // Aquí puedes realizar acciones en la pestaña activa
  chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
  });
});
