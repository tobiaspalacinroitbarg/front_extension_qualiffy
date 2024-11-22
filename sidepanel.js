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

    // Iniciar nueva sesión
    currentSessionId = await startSession();

    // Reiniciar arrays
    audioChunks = [];
    currentChunk = [];
    allTranscriptions = [];

    // Verificar permisos del micrófono primero
    const hasMicPermission = await requestMicrophonePermission();
    if (!hasMicPermission) {
      throw new Error('No se pudo obtener acceso al micrófono');
    }

    // Inicializar contexto de audio
    audioContext = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: 96000
    });

    // Obtener stream del micrófono
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 96000,
        sampleSize: 24
      }
    });

    // Capturar audio de la pestaña
    tabStream = await new Promise((resolve, reject) => {
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
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              sampleRate: 96000
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

    // Configuración del procesamiento de audio
    const tabGain = audioContext.createGain();
    tabGain.gain.value = 0.1;

    const micGain = audioContext.createGain();
    micGain.gain.value = 0.7;

    // Conectar fuentes
    tabAudioSource.connect(tabGain);
    micAudioSource.connect(micGain);


    audioDestination = audioContext.destination;
    tabGain.connect(audioDestination);
    
    // Crear nodo para grabación
    mediaStreamDestination = audioContext.createMediaStreamDestination();
    
    // Conectar al destino de grabación
    tabGain.connect(mediaStreamDestination);
    micGain.connect(mediaStreamDestination);

    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 320000
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