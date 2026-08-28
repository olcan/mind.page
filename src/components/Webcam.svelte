<!-- The NARRATION WEBCAM block (green-screen overlay video), extracted verbatim from
     index.svelte (Stage 2 DOM-only extraction; plan step 3). The parent gates it with
     {#if narrating} and owns the `intro` state and history interplay through onWebcamClick;
     everything here is presentation: the raw <style> and <script> elements are DOM elements
     injected on mount, exactly as they were inside the parent's {#if} block. The script reads
     page globals (window._, window._green_screen, window._modal — see client-globals.ts) and
     the #fragment-shader element from app.html. -->
<script lang="ts">
  export let narrating: boolean
  export let intro: boolean
  export let onWebcamClick: (e: MouseEvent) => void
</script>

{#if narrating}
  <style>
    .items {
      /* padding to make it easier to crop video */
      padding: 0 10px;
      padding-top: 10px;
      box-sizing: border-box; /* include added padding */
    }
    .webcam-background {
      position: fixed;
      z-index: 100;
      top: 0;
      left: 0;
      display: flex;
      width: 100%;
      height: 100%;
      justify-content: center;
      align-items: center;
      min-height: 100%;
      background: rgba(17, 17, 17, 0.8);
      opacity: 0;
      pointer-events: none;
      transition: all 0.5s ease-out;
    }
    .webcam-background.intro {
      opacity: 1;
      pointer-events: all;
    }
    .webcam {
      /* background: #333; */
      width: 550px;
      height: 400px;
      max-width: 34.375vw;
      max-height: 25vw;
      position: fixed;
      bottom: 0;
      right: 0;
      z-index: 1000; /* above modal */
      /* box-shadow: 0px 0px 20px 5px black; */
      /* border: 5px solid white; */
      /* border-radius: 50%; */
      /* border-bottom: 1px solid #222; */
      border-radius: 10px;
      transition: all 0.5s ease-out;
    }
    .webcam.intro {
      width: 68.75vw;
      height: 50vw;
      max-width: 68.75vw;
      max-height: 50vw;
      right: 15.625vw;
    }
    .webcam-title {
      z-index: 1001; /* just above .webcam */
      color: white;
      font-weight: 600;
      font-size: 10px;
      position: fixed;
      bottom: 5px;
      right: 5px;
      padding: 5px 10px;
      background: rgba(0, 0, 0, 0.5);
      border-radius: 5px;
      transition: all 0.5s ease-out;
    }
    .webcam-title.intro {
      right: 50%;
      font-size: 30px;
      transform: translateX(50%);
    }
  </style>

  <div class="webcam-background" class:intro on:click|self={onWebcamClick}></div>
  <!-- svelte-ignore a11y-media-has-caption -->
  <video id="webcam-video" class="webcam" class:intro style="visibility: hidden; z-index:-100"></video>
  <canvas id="webcam-canvas" class="webcam" class:intro on:click|self={onWebcamClick}></canvas>
  <div class="webcam-title" class:intro></div>

  <script>
    if (navigator?.mediaDevices?.getUserMedia) {
      if (navigator.mediaDevices.enumerateDevices) {
        console.debug(
          `initializing webcam, config: '${localStorage.getItem('mindpage_narrating')}'; available devices:`
        )
        navigator.mediaDevices.enumerateDevices().then(devices => {
          devices.forEach(device => {
            if (device.kind == 'videoinput') console.debug(device.deviceId, device.label)
          })
        })
      }

      // set up video and green screen canvas
      // see https://jameshfisher.com/2020/08/10/how-to-implement-green-screen-in-webgl/
      const video = document.getElementById('webcam-video')
      const canvas = document.getElementById('webcam-canvas')
      const gl = canvas.getContext('webgl')
      const vs = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(vs, 'attribute vec2 c; void main(void) { gl_Position=vec4(c, 0.0, 1.0); }')
      gl.compileShader(vs)
      const fs = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(fs, document.getElementById('fragment-shader').innerText)
      gl.compileShader(fs)
      const prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.useProgram(prog)
      const vb = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vb)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]), gl.STATIC_DRAW)
      const coordLoc = gl.getAttribLocation(prog, 'c')
      gl.vertexAttribPointer(coordLoc, 2, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(coordLoc)
      gl.activeTexture(gl.TEXTURE0)
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      const texLoc = gl.getUniformLocation(prog, 'tex')
      const texWidthLoc = gl.getUniformLocation(prog, 'texWidth')
      const texHeightLoc = gl.getUniformLocation(prog, 'texHeight')
      const keyColorLoc = gl.getUniformLocation(prog, 'keyColor')
      const similarityLoc = gl.getUniformLocation(prog, 'similarity')
      const smoothnessLoc = gl.getUniformLocation(prog, 'smoothness')
      const spillLoc = gl.getUniformLocation(prog, 'spill')
      const toggleLoc = gl.getUniformLocation(prog, 'toggle')

      // start webcam video
      navigator.mediaDevices
        .getUserMedia({
          video: _.merge(
            {
              width: 1100,
              height: 800,
              facingMode: 'user',
            },
            JSON.parse(localStorage.getItem('mindpage_narrating') || '{}')
          ),
        })
        .then(stream => {
          video.srcObject = stream
          video.play()
          // if we can not process the video, show it directly
          if (!video.requestVideoFrameCallback) {
            video.style.visibility = 'visible'
            video.style.zIndex = 1000
            return
          }
          function processFrame(now, metadata) {
            canvas.width = metadata.width
            canvas.height = metadata.height
            gl.viewport(0, 0, metadata.width, metadata.height)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video)
            gl.uniform1i(texLoc, 0)
            gl.uniform1f(texWidthLoc, metadata.width)
            gl.uniform1f(texHeightLoc, metadata.height)
            gl.uniform3f(keyColorLoc, 0, 1, 0)
            // see sliders at https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/
            gl.uniform1f(similarityLoc, _green_screen ? 0.49 : 0)
            gl.uniform1f(smoothnessLoc, 0.0)
            gl.uniform1f(spillLoc, 0.05)
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
            video.requestVideoFrameCallback(processFrame)
          }
          video.requestVideoFrameCallback(processFrame)
        })
        .catch(console.error)
    } else {
      _modal('unable to access webcam')
    }
  </script>
{/if}
