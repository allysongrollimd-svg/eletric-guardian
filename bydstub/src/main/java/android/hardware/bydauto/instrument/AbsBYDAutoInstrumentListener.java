package android.hardware.bydauto.instrument;

import android.hardware.bydauto.BYDAutoEventValue;

/** Stub de compilação. A classe real está no framework da central BYD. */
public abstract class AbsBYDAutoInstrumentListener {
    /**
     * Despacho genérico dos eventos. A implementação da BYD chama getters
     * protegidos por permissão aqui dentro, por isso o app sobrescreve sem super.
     */
    public void onDataChanged(int eventType, BYDAutoEventValue value) {
    }
}
