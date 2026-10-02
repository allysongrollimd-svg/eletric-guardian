package com.overdrive.app.ui.customer

import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import com.overdrive.app.ui.util.PreferencesManager

/**
 * "Modo cliente": after the installer finishes, the car shows only the connect screen, live view and
 * recordings. The installer's PIN (set when the mode is turned on) brings the complete app back.
 */
object CustomerMode {
    /** Rail destinations kept in customer mode. The "about" row becomes the installer's way back. */
    val visibleKeys = setOf("integrations", "live", "recordings", "about")

    private var failures = 0
    private var lockedUntil = 0L

    fun isOn(): Boolean = PreferencesManager.isCustomerMode()

    private fun pinField(context: Context, hint: String): EditText = EditText(context).apply {
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        this.hint = hint
        filters = arrayOf(android.text.InputFilter.LengthFilter(8))
    }

    private fun column(context: Context, vararg views: android.view.View) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        val pad = (20 * context.resources.displayMetrics.density).toInt()
        setPadding(pad, pad / 2, pad, 0)
        views.forEach { addView(it) }
    }

    /** Asks the installer for a PIN (twice) and turns the mode on. */
    fun showEnableDialog(context: Context, onEnabled: () -> Unit) {
        val a = pinField(context, "PIN do instalador (4 a 8 números)")
        val b = pinField(context, "Repita o PIN")
        val info = TextView(context).apply {
            text = "O carro vai mostrar só a tela de conectar, o Ao vivo e as Gravações. Guarde este PIN: sem ele ninguém abre o restante do app."
        }
        val dlg = AlertDialog.Builder(context)
            .setTitle("Ativar modo cliente")
            .setView(column(context, info, a, b))
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Ativar", null)
            .create()
        dlg.setOnShowListener {
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val p1 = a.text.toString()
                when {
                    p1.length < 4 -> Toast.makeText(context, "O PIN precisa de pelo menos 4 números.", Toast.LENGTH_SHORT).show()
                    p1 != b.text.toString() -> Toast.makeText(context, "Os PINs não são iguais.", Toast.LENGTH_SHORT).show()
                    else -> { PreferencesManager.enableCustomerMode(p1); dlg.dismiss(); onEnabled() }
                }
            }
        }
        dlg.show()
    }

    /** Asks for the PIN and, when right, turns the mode off. */
    fun showExitDialog(context: Context, onDisabled: () -> Unit) {
        val pin = pinField(context, "PIN do instalador")
        val dlg = AlertDialog.Builder(context)
            .setTitle("Modo técnico")
            .setMessage("Digite o PIN do instalador para abrir o app completo.")
            .setView(column(context, pin))
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Entrar", null)
            .create()
        dlg.setOnShowListener {
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val now = System.currentTimeMillis()
                if (now < lockedUntil) {
                    Toast.makeText(context, "Muitas tentativas. Aguarde ${(lockedUntil - now) / 1000 + 1} s.", Toast.LENGTH_SHORT).show()
                } else if (PreferencesManager.disableCustomerMode(pin.text.toString())) {
                    failures = 0; dlg.dismiss(); onDisabled()
                } else {
                    if (++failures >= 5) { failures = 0; lockedUntil = now + 30_000 }
                    Toast.makeText(context, "PIN incorreto.", Toast.LENGTH_SHORT).show()
                    pin.text.clear()
                }
            }
        }
        dlg.show()
    }
}
