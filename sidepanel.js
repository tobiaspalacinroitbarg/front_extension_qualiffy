let mediaRecorder;
let audioChunks = [];
let audioContext;
let tabAudioSource;
let micAudioSource;
let audioDestination;
let mediaStreamDestination;
let isRecording = false;
let timerInterval;
let startTime;
let elapsedTime = 0;

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

async function startCapture() {
  try {
    if (isRecording) {
      console.log('Ya está grabando');
      return;
    }

    // Verificar permisos del micrófono primero
    const hasMicPermission = await requestMicrophonePermission();
    if (!hasMicPermission) {
      throw new Error('No se pudo obtener acceso al micrófono');
    }

    // Inicializar contexto de audio con mayor calidad
    audioContext = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: 96000
    });

    // Obtener stream del micrófono con configuración mejorada
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,  
        channelCount: 1,
        sampleRate: 60000,
        sampleSize: 24
      }
    });

    // Capturar audio de la pestaña con configuración optimizada
    const tabStream = await new Promise((resolve, reject) => {
      chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
        if (!tabs[0]) {
          reject(new Error('No se encontró una pestaña activa'));
          return;
        }

        chrome.tabCapture.capture({
          audio: true,
          video: false,
          audioConstraints: {
            mandatory: {
              chromeMediaSource: 'tab',
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          }
        }, stream => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!stream) {
            reject(new Error('No se pudo obtener el stream de la pestaña'));
            return;
          }
          resolve(stream);
        });
      });
    });

    // Crear y conectar nodos de audio
    tabAudioSource = audioContext.createMediaStreamSource(tabStream);
    micAudioSource = audioContext.createMediaStreamSource(micStream);

    // Configuración del procesamiento de audio para la pestaña
    // 1. Ecualizador para mejorar claridad
    const tabEQ = audioContext.createBiquadFilter();
    tabEQ.type = 'lowshelf';
    tabEQ.frequency.value = 100;
    tabEQ.gain.value = -3;

    const tabEQMid = audioContext.createBiquadFilter();
    tabEQMid.type = 'peaking';
    tabEQMid.frequency.value = 2500;
    tabEQMid.Q.value = 1;
    tabEQMid.gain.value = 2;

    const tabEQHigh = audioContext.createBiquadFilter();
    tabEQHigh.type = 'highshelf';
    tabEQHigh.frequency.value = 8000;
    tabEQHigh.gain.value = 1;

    // 2. Compresor para mejorar la dinámica
    const tabCompressor = audioContext.createDynamicsCompressor();
    tabCompressor.threshold.value = -24;
    tabCompressor.knee.value = 12;
    tabCompressor.ratio.value = 2.5;
    tabCompressor.attack.value = 0.005;
    tabCompressor.release.value = 0.1;

    // 3. Limitador suave para evitar distorsión
    const tabLimiter = audioContext.createDynamicsCompressor();
    tabLimiter.threshold.value = -3;
    tabLimiter.knee.value = 0;
    tabLimiter.ratio.value = 20;
    tabLimiter.attack.value = 0.003;
    tabLimiter.release.value = 0.01;

    // Ganancia final para el tab
    const tabGain = audioContext.createGain();
    tabGain.gain.value = 0.1;

    // Ganancia para el micrófono
    const micGain = audioContext.createGain();
    micGain.gain.value = 0.7;

    // Conectar la cadena de procesamiento del tab
    tabAudioSource
      .connect(tabEQ)
      .connect(tabEQMid)
      .connect(tabEQHigh)
      .connect(tabCompressor)
      .connect(tabLimiter)
      .connect(tabGain);

    // Crear compresor para el micrófono
    const micCompressor = audioContext.createDynamicsCompressor();
    micCompressor.threshold.value = -24;    // Umbral de compresión
    micCompressor.knee.value = 10;          // Suavidad de la compresión
    micCompressor.ratio.value = 4;          // Ratio de compresión
    micCompressor.attack.value = 0.005;     // Tiempo de ataque
    micCompressor.release.value = 0.25;     // Tiempo de liberación

    // Crear ecualizador para el micrófono
    const micEQ = audioContext.createBiquadFilter();
    micEQ.type = 'highpass';
    micEQ.frequency.value = 80;  // Eliminar frecuencias muy bajas

    const micPresence = audioContext.createBiquadFilter();
    micPresence.type = 'peaking';
    micPresence.frequency.value = 3000;  // Realzar presencia de voz
    micPresence.Q.value = 1;
    micPresence.gain.value = 3;

    // Conectar cadena de procesamiento del micrófono
    micAudioSource
      .connect(micEQ)
      .connect(micPresence)
      .connect(micCompressor)
      .connect(micGain);

    // Crear nodo para reproducción
    audioDestination = audioContext.destination;

    // Crear y configurar el merger para la grabación
    const mergerForRecording = audioContext.createChannelMerger(2);
    tabGain.connect(mergerForRecording, 0, 0);
    micGain.connect(mergerForRecording, 0, 1);

    // Crear un segundo merger para la reproducción
    const mergerForPlayback = audioContext.createChannelMerger(2);
    tabGain.connect(mergerForPlayback);
    micGain.connect(mergerForPlayback);
    
    // Conectar el merger de reproducción al destino de audio
    mergerForPlayback.connect(audioDestination);
    
    // Configurar la grabación con mayor calidad
    mediaStreamDestination = audioContext.createMediaStreamDestination();
    mergerForRecording.connect(mediaStreamDestination);

    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 320000  // Aumentado a 320kbps para mejor calidad
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      audioChunks = [];
      convertToWav(audioBlob);
      
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

    // Iniciar la grabación
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
    
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
    }
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    isRecording = false;
    updateButtonStates();
    stopTimer();
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
  const percentageElement = document.querySelector('.card .metric .percentage');
  if (percentageElement) {
    percentageElement.textContent = manejo + "%";
  } else {
    console.error('No se encontró el elemento del porcentaje');
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