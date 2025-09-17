let mediaRecorder;
let audioChunks = [];
let currentChunk = [];
let audioContext;
let tabAudioSource;
let micAudioSource;
let audioDestination;
let mediaStreamDestination;
let isRecording = false;
let timerInterval;
let startTime;
let elapsedTime = 0;
let chunkInterval;
let allTranscriptions = [];
let currentSessionId = null;
let tabStream = null;
let micStream = null;

const CHUNK_DURATION = 10000; // 10 segundos en milisegundos

// Añadir esta función al principio de tu sidepanel.js
async function requestTabPermissions() {
  return new Promise((resolve) => {
    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
      if (!tabs[0]) {
        console.error('No se encontró pestaña activa');
        resolve(false);
        return;
      }

      const tab = tabs[0];
      console.log('Pestaña activa:', tab.url);

      // Verificar si ya tenemos permisos
      const hasPermission = await chrome.permissions.contains({
        origins: [tab.url]
      });

      if (hasPermission) {
        console.log('Ya tenemos permisos para esta pestaña');
        resolve(true);
        return;
      }

      // Solicitar permisos
      try {
        const granted = await chrome.permissions.request({
          origins: [tab.url]
        });
        
        if (granted) {
          console.log('Permisos concedidos para:', tab.url);
          resolve(true);
        } else {
          console.log('Permisos denegados');
          resolve(false);
        }
      } catch (error) {
        console.error('Error solicitando permisos:', error);
        resolve(false);
      }
    });
  });
}


async function startSession() {
  try {
    const response = await fetch('http://localhost:8000/start-session', {
      method: 'POST'
    });
    const data = await response.json();
    return data.session_id;
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    throw error;
  }
}

async function processAudioChunk(audioBlob) {
  try {
    if (!currentSessionId) {
      throw new Error('No hay sesión activa');
    }

    const formData = new FormData();
    formData.append('file', audioBlob, 'chunk.wav');

    const response = await fetch(`http://localhost:8000/process-chunk/${currentSessionId}`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }

    // Actualizar métricas en tiempo real
    if (data.consejo) {
      updateConsejo(data.consejo);
    }
    if (data.manejo) {
      updateManejo(data.manejo);
    }

    // Guardar la transcripción
    if (data.transcription) {
      allTranscriptions.push(data.transcription);
    }

  } catch (error) {
    console.error('Error al procesar chunk de audio:', error);
  }
}

async function endSession() {
  try {
    if (!currentSessionId) return;

    const response = await fetch(`http://localhost:8000/end-session/${currentSessionId}`, {
      method: 'POST'
    });
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }

    // Actualizar métricas finales
    if (data.final_consejo) {
      updateConsejo(data.final_consejo);
    }
    if (data.final_manejo) {
      updateManejo(data.final_manejo);
    }

    currentSessionId = null;
  } catch (error) {
    console.error('Error al finalizar sesión:', error);
  }
}

async function startCapture() {
  try {
    if (isRecording) {
      console.log('Ya está grabando');
      return;
    }

    // PASO 1: Solicitar permisos de pestaña
    console.log('Solicitando permisos de pestaña...');
    const hasTabPermission = await requestTabPermissions();
    
    if (!hasTabPermission) {
      throw new Error('No se obtuvieron permisos para capturar la pestaña');
    }

    // PASO 2: Verificar permisos del micrófono
    const hasMicPermission = await requestMicrophonePermission();
    if (!hasMicPermission) {
      throw new Error('No se pudo obtener acceso al micrófono');
    }

    // PASO 3: Iniciar nueva sesión
    currentSessionId = await startSession();

    // Reiniciar arrays
    audioChunks = [];
    currentChunk = [];
    allTranscriptions = [];

    // PASO 4: Inicializar contexto de audio
    audioContext = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: 48000  // Reducir a 48kHz para mejor compatibilidad
    });

    // PASO 5: Obtener stream del micrófono
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
        sampleSize: 16
      }
    });

    // PASO 6: Capturar audio de la pestaña
    console.log('Iniciando captura de pestaña...');
    tabStream = await new Promise((resolve, reject) => {
      chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
        if (!tabs[0]) {
          reject(new Error('No se encontró una pestaña activa'));
          return;
        }

        const tab = tabs[0];
        console.log('Capturando audio de pestaña:', tab.url);

        chrome.tabCapture.capture({
          audio: true,
          video: false,
          audioConstraints: {
            mandatory: {
              chromeMediaSource: 'tab',
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
              sampleRate: 48000
            }
          }
        }, stream => {
          if (chrome.runtime.lastError) {
            console.error('Error en tabCapture:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!stream) {
            reject(new Error('No se pudo obtener el stream de la pestaña'));
            return;
          }
          
          console.log('Stream de pestaña obtenido correctamente');
          resolve(stream);
        });
      });
    });

    // PASO 7: Crear y conectar nodos de audio (resto del código igual)
    tabAudioSource = audioContext.createMediaStreamSource(tabStream);
    micAudioSource = audioContext.createMediaStreamSource(micStream);

    const tabGain = audioContext.createGain();
    tabGain.gain.value = 0.1;

    const micGain = audioContext.createGain();
    micGain.gain.value = 0.7;

    tabAudioSource.connect(tabGain);
    micAudioSource.connect(micGain);

    audioDestination = audioContext.destination;
    tabGain.connect(audioDestination);
    
    mediaStreamDestination = audioContext.createMediaStreamDestination();
    tabGain.connect(mediaStreamDestination);
    micGain.connect(mediaStreamDestination);

    // Resto de tu código de MediaRecorder...
    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000  // Reducir bitrate
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        currentChunk.push(event.data);
        audioChunks.push(event.data);
      }
    };

    // Procesar chunks cada 10 segundos
    chunkInterval = setInterval(async () => {
      if (currentChunk.length > 0) {
        const chunkBlob = new Blob(currentChunk, { type: 'audio/webm' });
        currentChunk = []; // Reiniciar para el siguiente chunk
        
        // Convertir a WAV y procesar
        const reader = new FileReader();
        reader.readAsArrayBuffer(chunkBlob);
        reader.onloadend = async () => {
          const audioBuffer = reader.result;
          const wavBlob = new Blob([audioBuffer], { type: 'audio/wav' });
          await processAudioChunk(wavBlob);
        };
      }
    }, CHUNK_DURATION);

    mediaRecorder.onstop = async () => {
      clearInterval(chunkInterval);
      
      // Procesar último chunk si existe
      if (currentChunk.length > 0) {
        const finalChunkBlob = new Blob(currentChunk, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsArrayBuffer(finalChunkBlob);
        reader.onloadend = async () => {
          const audioBuffer = reader.result;
          const wavBlob = new Blob([audioBuffer], { type: 'audio/wav' });
          await processAudioChunk(wavBlob);
          
          // Finalizar sesión después de procesar el último chunk
          await endSession();
        };
      } else {
        await endSession();
      }

      // Limpiar recursos
      if (tabStream) {
        tabStream.getTracks().forEach(track => track.stop());
      }
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
      }
      
      isRecording = false;
      updateButtonStates();
    };

    // Iniciar grabación
    mediaRecorder.start(1000);
    isRecording = true;
    updateButtonStates();
    startTimer();
    console.log('Grabación iniciada correctamente');

  } catch (error) {
    console.error('Error detallado:', error);
    alert(`Error al iniciar la captura: ${error.message}`);
    isRecording = false;
    updateButtonStates();
    
    // Limpiar recursos en caso de error
    if (tabStream) {
      tabStream.getTracks().forEach(track => track.stop());
    }
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
    }
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    clearInterval(chunkInterval);
    mediaRecorder.stop();
    isRecording = false;
    updateButtonStates();
    stopTimer();
  }
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function startTimer() {
  const timerDisplay = document.querySelector('.timer-display');
  if (!timerDisplay) {
    console.error('No se encontró el elemento timer-display');
    return;
  }
  
  startTime = Date.now();
  elapsedTime = 0;
  timerDisplay.classList.add('active');
  
  // Actualizar inmediatamente y luego cada 100ms para una actualización más suave
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 100);
}

function updateTimerDisplay() {
  const timerDisplay = document.querySelector('.timer-display');
  if (!timerDisplay) return;
  
  elapsedTime = Date.now() - startTime;
  timerDisplay.textContent = formatTime(elapsedTime);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  const timerDisplay = document.querySelector('.timer-display');
  if (timerDisplay) {
    timerDisplay.classList.remove('active');
    elapsedTime = 0;
    timerDisplay.textContent = '00:00';
  }
}

async function requestMicrophonePermission() {
  try {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (err) {
    console.error('Error específico al solicitar micrófono:', err.name, err.message);
    return false;
  }
}

function updateButtonStates() {
  const startBtn = document.querySelector('.start-btn');
  const stopBtn = document.querySelector('.stop-btn');
  
  if (startBtn && stopBtn) {
    if (isRecording) {
      startBtn.disabled = true;
      startBtn.classList.add('disabled');
      stopBtn.disabled = false;
      stopBtn.classList.remove('disabled');
    } else {
      startBtn.disabled = false;
      startBtn.classList.remove('disabled');
      stopBtn.disabled = true;
      stopBtn.classList.add('disabled');
    }
  }
}

function convertToWav(blob) {
  const reader = new FileReader();
  reader.readAsArrayBuffer(blob);
  reader.onloadend = async () => {
    try {
      const audioBuffer = reader.result;
      const wavBlob = new Blob([audioBuffer], { type: 'audio/wav' });
      
      // Enviar al servidor
      await sendAudioToServer(wavBlob);
      
      // Descargar el archivo localmente
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audio_${new Date().toISOString()}.wav`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error al procesar el audio:', error);
      alert(`Error al procesar el audio: ${error.message}`);
    }
  };
}

async function sendAudioToServer(audioBlob) {
  try {
    console.log('Iniciando envío de audio al servidor...');
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.wav');

    const response = await fetch('http://localhost:8000/process-mc', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Respuesta del servidor:', data);

    if (data.error) {
      throw new Error(data.error);
    }

    if (data.consejo) {
      updateConsejo(data.consejo);
    } else {
      console.warn('No se recibió datos del consejo');
    }

    if (data.manejo) {
      updateManejo(data.manejo);
    } else {
      console.warn('No se recibió datos del manejo');
    }

  } catch (error) {
    console.error('Error al enviar audio al servidor:', error);
    alert('Error al procesar el audio: ' + error.message);
  }
}

function updateAsesor(problema,solucion) {
  console.log('Actualizando asesor');
  const asesorCard = document.querySelector('.card:nth-child(2)');
  if (asesorCard) {
    asesorCard.innerHTML = `
      <h3>Asesor IA</h3>
      <p>${problema}</p>
      <button class="action-btn">${solucion}</button>
    `;
  } else {
    console.error('No se encontró el elemento del asesor');
  }
}

function updateConsejo(consejo) {
  console.log('Actualizando consejo:', consejo);
  const consejoCard = document.querySelector('.card:nth-child(3)');
  if (consejoCard) {
    consejoCard.innerHTML = `
      <h3>Tener en cuenta...</h3>
      <p>${consejo}</p>
    `;
  } else {
    console.error('No se encontró el elemento del consejo');
  }
}
function updateManejo(manejo) {
  console.log('Actualizando manejo:', manejo);

  // Actualizar el porcentaje en el elemento correspondiente
  const percentageElement = document.querySelector('.card .metric .percentage');
  if (percentageElement) {
    percentageElement.textContent = manejo + "%";
  } else {
    console.error('No se encontró el elemento del porcentaje');
    return;
  }

  // Cambiar colores según el porcentaje
  const graphElement = document.querySelector('.graph polyline');
  const containerElement = document.querySelector('.card .metric');
  if (manejo < 30) {
    graphElement.style.stroke = "#4CAF50"; // Verde
    percentageElement.style.color = "#4CAF50";
  } else if (manejo >= 30 && manejo <= 50) {
    graphElement.style.stroke = "#FFC107"; // Amarillo
    percentageElement.style.color = "#FFC107";
  } else {
    graphElement.style.stroke = "#FF4D4D"; // Rojo
    percentageElement.style.color = "#FF4D4D";
  }

  // Desplazar las coordenadas del polyline y agregar una nueva
  if (graphElement) {
    let points = graphElement.getAttribute('points').trim();
    let pointsArray = points.split(' ').map(coord => {
      const [x, y] = coord.split(',').map(Number);
      return { x, y };
    });

    // Mover las coordenadas hacia la izquierda y eliminar la primera
    pointsArray.shift();

    // Calcular nueva coordenada proporcional al manejo
    const newY = 20 - (manejo / 100) * 20; // Convertir el manejo en proporción
    pointsArray.push({ x: 100, y: newY });

    // Normalizar las coordenadas X para mantener los pasos uniformes
    pointsArray = pointsArray.map((point, index) => ({
      x: index * 10, // Reasignar X con un intervalo de 10
      y: point.y
    }));

    // Actualizar los puntos en el atributo `points` del polyline
    const updatedPoints = pointsArray.map(point => `${point.x},${point.y}`).join(' ');
    graphElement.setAttribute('points', updatedPoints);
  } else {
    console.error('No se encontró el elemento del polyline');
  }
}


document.addEventListener('DOMContentLoaded', () => {
  updateButtonStates();
  
  const startBtn = document.querySelector('.start-btn');
  const stopBtn = document.querySelector('.stop-btn');
  
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        await startCapture();
      } catch (error) {
        console.error('Error en startBtn:', error);
      }
    });
  }
  
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      try {
        stopCapture();
      } catch (error) {
        console.error('Error en stopBtn:', error);
      }
    });
  }
});
// Selector de tab mejorado con detección robusta
let selectedTab = null;
let isDetectingTab = false;

// Función mejorada para obtener la pestaña actual
async function selectCurrentTab() {
  if (isDetectingTab) return;
  
  try {
    isDetectingTab = true;
    const btn = document.getElementById('selectCurrentTab');
    
    // Mostrar estado de carga
    if (btn) {
      btn.classList.add('loading');
      updateTabDisplay({
        title: 'Detectando pestaña...',
        url: 'Buscando pestaña activa...',
        icon: '⏳'
      }, false);
    }
    
    console.log('Detectando pestaña activa...');
    
    // Método 1: Intentar obtener pestaña via background
    let tab = await getTabViaBackground();
    
    // Método 2: Si falla, intentar obtener directamente
    if (!tab || !tab.url || tab.url === 'Sin URL') {
      console.log('Método background falló, intentando método directo...');
      tab = await getTabDirectly();
    }
    
    // Método 3: Si aún falla, obtener la primera pestaña disponible
    if (!tab || !tab.url || tab.url === 'Sin URL') {
      console.log('Método directo falló, obteniendo cualquier pestaña disponible...');
      tab = await getAnyAvailableTab();
    }
    
    if (tab && tab.url && tab.url !== 'Sin URL') {
      selectedTab = tab;
      updateTabDisplay(tab, true);
      console.log('✅ Pestaña detectada:', tab.title, tab.url);
      
      // Mostrar indicador de éxito
      showSuccessNotification('Pestaña detectada correctamente');
    } else {
      throw new Error('No se pudo detectar ninguna pestaña válida');
    }
    
  } catch (error) {
    console.error('❌ Error detectando pestaña:', error);
    updateTabDisplay({
      title: 'Error de detección',
      url: 'No se pudo detectar la pestaña activa',
      icon: '❌'
    }, false);
    
    showErrorNotification('Error al detectar la pestaña: ' + error.message);
  } finally {
    isDetectingTab = false;
    const btn = document.getElementById('selectCurrentTab');
    if (btn) {
      btn.classList.remove('loading');
    }
  }
}

// Método 1: Obtener tab via background script
async function getTabViaBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({action: 'getCurrentTab'}, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Error en background:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      
      if (response && response.tab) {
        console.log('Tab obtenida via background:', response.tab);
        resolve(response.tab);
      } else {
        resolve(null);
      }
    });
  });
}

// Método 2: Obtener tab directamente
async function getTabDirectly() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (chrome.runtime.lastError) {
          console.log('Error query directo:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        
        if (tabs && tabs.length > 0 && tabs[0]) {
          console.log('Tab obtenida directamente:', tabs[0]);
          resolve(tabs[0]);
        } else {
          resolve(null);
        }
      });
    } catch (error) {
      console.log('Error en método directo:', error);
      resolve(null);
    }
  });
}

// Método 3: Obtener cualquier tab disponible
async function getAnyAvailableTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        
        // Buscar la primera pestaña que no sea chrome:// o extension://
        const validTab = tabs.find(tab => 
          tab.url && 
          !tab.url.startsWith('chrome://') && 
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:')
        );
        
        if (validTab) {
          console.log('Tab válida encontrada:', validTab);
          resolve(validTab);
        } else {
          resolve(null);
        }
      });
    } catch (error) {
      resolve(null);
    }
  });
}

// Función para actualizar la visualización del botón
function updateTabDisplay(tab, isSelected = false) {
  const btn = document.getElementById('selectCurrentTab');
  if (!btn) return;
  
  const iconElement = btn.querySelector('.tab-icon');
  const titleElement = btn.querySelector('.tab-title');
  const urlElement = btn.querySelector('.tab-url');
  const statusElement = btn.querySelector('.tab-status');
  
  if (iconElement) {
    iconElement.textContent = tab.icon || (isSelected ? '✅' : '🎯');
  }
  
  if (titleElement) {
    titleElement.textContent = truncateText(tab.title || 'Sin título', 35);
  }
  
  if (urlElement) {
    const displayUrl = formatUrl(tab.url || 'Sin URL');
    urlElement.textContent = truncateText(displayUrl, 40);
  }
  
  if (statusElement) {
    statusElement.style.display = isSelected ? 'flex' : 'none';
  }
  
  // Actualizar clases
  btn.classList.toggle('selected', isSelected);
}

// Funciones auxiliares
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function formatUrl(url) {
  try {
    if (url === 'Sin URL' || !url) return 'Sin URL';
    const urlObj = new URL(url);
    return urlObj.hostname + urlObj.pathname;
  } catch {
    return url;
  }
}

function showSuccessNotification(message) {
  console.log('✅ ' + message);
  // Aquí puedes añadir una notificación visual si quieres
}

function showErrorNotification(message) {
  console.error('❌ ' + message);
  // Aquí puedes añadir una notificación visual de error si quieres
}

// Función para auto-detectar pestaña al cargar
async function autoDetectTab() {
  // Esperar un poco para que Chrome esté listo
  setTimeout(() => {
    selectCurrentTab();
  }, 500);
}

// Event listener mejorado
document.addEventListener('DOMContentLoaded', () => {
  // Tu código existente...
  updateButtonStates();
  
  const startBtn = document.querySelector('.start-btn');
  const stopBtn = document.querySelector('.stop-btn');
  
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        await startCapture();
      } catch (error) {
        console.error('Error en startBtn:', error);
      }
    });
  }
  
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      try {
        stopCapture();
      } catch (error) {
        console.error('Error en stopBtn:', error);
      }
    });
  }
  
  // Event listener para el botón de seleccionar tab
  const selectTabBtn = document.getElementById('selectCurrentTab');
  if (selectTabBtn) {
    selectTabBtn.addEventListener('click', selectCurrentTab);
    
    // Auto-detectar pestaña al cargar
    autoDetectTab();
  }
});