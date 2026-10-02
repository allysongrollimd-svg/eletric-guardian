package br.com.eletricguardian.app.camera

import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.Camera
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Tira uma foto JPEG de uma câmera. Primeiro passo da dashcam: ver qual câmera
 * física o DiLink entrega para apps (no Dolphin GS só aparece a id 0).
 *
 * Usa a API antiga (android.hardware.Camera): no DiLink 3.0 a câmera é "legacy"
 * e o Camera2 quebra já ao ler as características ("Supported FPS ranges cannot
 * be null").
 */
@Suppress("DEPRECATION")
object CameraSnapshot {
    private const val TAG = "EG-Camera"

    fun cameraIds(): List<Int> = (0 until Camera.getNumberOfCameras()).toList()

    fun take(@Suppress("UNUSED_PARAMETER") context: Context, id: Int = 0, timeoutMs: Long = 10000): ByteArray? {
        // A câmera manda os callbacks para o Looper do thread que a abriu.
        val thread = HandlerThread("EG-Camera").apply { start() }
        val done = CountDownLatch(1)
        var jpeg: ByteArray? = null
        var camera: Camera? = null
        Handler(thread.looper).post {
            try {
                val cam = Camera.open(id).also { camera = it }
                val params = cam.parameters
                params.supportedPictureSizes?.maxByOrNull { it.width * it.height }?.let { params.setPictureSize(it.width, it.height) }
                params.jpegQuality = 85
                runCatching { cam.parameters = params }
                Log.i(TAG, "câmera $id: foto ${cam.parameters.pictureSize.width}x${cam.parameters.pictureSize.height}, " +
                    "prévia ${cam.parameters.previewSize.width}x${cam.parameters.previewSize.height}")
                cam.setPreviewTexture(SurfaceTexture(10))
                cam.startPreview()
                // Deixa a exposição assentar antes da foto.
                Handler(thread.looper).postDelayed({
                    runCatching {
                        cam.takePicture(null, null) { data, _ ->
                            jpeg = data
                            done.countDown()
                        }
                    }.onFailure {
                        Log.w(TAG, "takePicture falhou na câmera $id", it)
                        done.countDown()
                    }
                }, 1500)
            } catch (t: Throwable) {
                Log.w(TAG, "foto da câmera $id falhou", t)
                done.countDown()
            }
        }
        done.await(timeoutMs, TimeUnit.MILLISECONDS)
        Handler(thread.looper).post {
            runCatching { camera?.stopPreview() }
            runCatching { camera?.release() }
            thread.quitSafely()
        }
        return jpeg
    }
}
