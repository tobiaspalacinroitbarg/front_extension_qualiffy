// background.js - Service Worker (SIN document ni DOM)
console.log('Qualiffy background iniciado');

// ABRIR PANEL LATERAL al hacer clic en el icono
chrome.action.onClicked.addListener(async (tab) => {
  try {
    console.log('Abriendo panel lateral...');
    await chrome.sidePanel.open({ windowId: tab.windowId });
    console.log('Panel lateral abierto correctamente');
  } catch (error) {
    console.error('Error abriendo panel lateral:', error);
  }
});

// Manejar mensajes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Mensaje recibido:', request);
  
  switch (request.action) {
    case 'contentLoaded':
      console.log('Content script cargado');
      break;
    case 'openSidePanel':
      chrome.sidePanel.open({ windowId: sender.tab?.windowId }).catch(console.error);
      break;
    case 'getCurrentTab':
      // Devolver info de la pestaña actual
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        sendResponse({tab: tabs[0]});
      });
      return true; // Mantener canal abierto para respuesta asíncrona
  }
  
  sendResponse({status: 'received'});
});