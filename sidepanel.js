// Variables globales
let mediaRecorder;
let audioChunks = [];
let audioContext;
let tabAudioSource;
let micAudioSource;
let audioDestination;
let mediaStreamDestination;
let isRecording = false;

// Función para verificar y solicitar permisos del micrófono
async function requestMicrophonePermission() {
  try {
    // Solicitar permiso explícitamente
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach(track => track.stop()); // Liberar el stream de prueba
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
      sampleRate: 48000  // Aumentado a 48kHz para mejor calidad
    });

    // Obtener stream del micrófono con configuración mejorada
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,  // Desactivado para mejor control manual
        channelCount: 1,
        sampleRate: 48000,
        sampleSize: 24
      }
    });

    // Capturar audio de la pestaña con mayor calidad
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
              echoCancellation: true,  // Desactivado para mejor calidad
              noiseSuppression: true,  // Desactivado para mejor calidad
              autoGainControl: false    // Desactivado para mejor control manual
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
    
    // Crear ganancias para controlar niveles
    const tabGain = audioContext.createGain();
    const micGain = audioContext.createGain();
    
    // Ajustar ganancias (aumentado para el micrófono)
    tabGain.gain.value = 0.7;    // Ganancia del tab aumentada ligeramente
    micGain.gain.value = 1.0;    // Ganancia del micrófono aumentada significativamente

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

    // Conectar cadena de procesamiento del tab
    tabAudioSource.connect(tabGain);

    // Crear nodo para reproducción
    audioDestination = audioContext.destination;

    // Crear y configurar el merger para la grabación
    const mergerForRecording = audioContext.createChannelMerger(2);
    tabGain.connect(mergerForRecording, 0, 0);
    micGain.connect(mergerForRecording, 0, 1);

    // Crear un segundo merger para la reproducción
    const mergerForPlayback = audioContext.createChannelMerger(2);
    tabGain.connect(mergerForPlayback);
    
    // Conectar el merger de reproducción al destino de audio
    mergerForPlayback.connect(audioDestination);
    
    // Configurar la grabación con mayor calidad
    mediaStreamDestination = audioContext.createMediaStreamDestination();
    mergerForRecording.connect(mediaStreamDestination);

    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 256000  // Aumentado a 256kbps para mejor calidad
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
// Función para detener la captura
function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    isRecording = false;
    updateButtonStates();
  }
}

// Función para actualizar el estado de los botones
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

// Convertir el blob a archivo .wav
function convertToWav(blob) {
  const reader = new FileReader();
  reader.readAsArrayBuffer(blob);
  reader.onloadend = () => {
    try {
      const audioBuffer = reader.result;
      const url = URL.createObjectURL(new Blob([audioBuffer], { type: 'audio/wav' }));
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `audio_${new Date().toISOString()}.wav`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error al convertir/descargar el audio:', error);
      alert(`Error al procesar el audio: ${error.message}`);
    }
  };
}

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
  updateButtonStates();
  
  // Agregar event listeners a los botones
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