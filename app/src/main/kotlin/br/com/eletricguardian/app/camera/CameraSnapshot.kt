package br.com.eletricguardian.app.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Tira uma foto JPEG de uma câmera do Camera2. Primeiro passo da dashcam: ver
 * qual câmera física o DiLink entrega para apps (no Dolphin GS só aparece a id 0).
 */
object CameraSnapshot {
    private const val TAG = "EG-Camera"

    fun cameraIds(context: Context): List<String> =
        runCatching { (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager).cameraIdList.toList() }
            .getOrDefault(emptyList())

    @SuppressLint("MissingPermission")
    fun take(context: Context, id: String = "0", timeoutMs: Long = 8000): ByteArray? {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val thread = HandlerThread("EG-Camera").apply { start() }
        val handler = Handler(thread.looper)
        val done = CountDownLatch(1)
        var jpeg: ByteArray? = null
        var device: CameraDevice? = null
        var reader: ImageReader? = null
        try {
            val sizes = manager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(ImageFormat.JPEG)
            val size = sizes?.maxByOrNull { it.width * it.height } ?: return null
            Log.i(TAG, "câmera $id: ${size.width}x${size.height}")
            reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2).apply {
                setOnImageAvailableListener({ r ->
                    r.acquireLatestImage()?.use { img ->
                        val buf = img.planes[0].buffer
                        jpeg = ByteArray(buf.remaining()).also { buf.get(it) }
                    }
                    done.countDown()
                }, handler)
            }
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    device = camera
                    @Suppress("DEPRECATION")
                    camera.createCaptureSession(listOf(reader.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            // Alguns frames de preview para a exposição assentar antes da foto.
                            val preview = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(reader.surface) }
                            val still = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                addTarget(reader.surface)
                                set(CaptureRequest.JPEG_QUALITY, 85.toByte())
                            }
                            handler.postDelayed({ runCatching { session.capture(still.build(), null, handler) } }, 1500)
                            runCatching { session.setRepeatingRequest(preview.build(), null, handler) }
                        }

                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            Log.w(TAG, "sessão da câmera $id falhou")
                            done.countDown()
                        }
                    }, handler)
                }

                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    done.countDown()
                }

                override fun onError(camera: CameraDevice, error: Int) {
                    Log.w(TAG, "erro $error na câmera $id")
                    camera.close()
                    done.countDown()
                }
            }, handler)
            done.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (t: Throwable) {
            Log.w(TAG, "foto da câmera $id falhou", t)
        } finally {
            runCatching { device?.close() }
            runCatching { reader?.close() }
            thread.quitSafely()
        }
        return jpeg
    }
}
