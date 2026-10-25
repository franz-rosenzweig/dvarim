package xyz.tiresia.dvarim;

import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.MotionEvent;

/**
 * Palm rejection for the WebView, before the page or the WebView's own
 * scrolling sees anything: a hand resting on the screen while the S Pen
 * writes must neither tap nor scroll.
 *
 * - While a stylus is in range (hovering), touching, or lifted less than half
 *   a second ago, finger touches are dropped. A finger gesture already under
 *   way when the pen comes near is cancelled first, so the page never sees
 *   half of one.
 * - In a gesture the stylus is part of, the fingers are taken out and the
 *   stylus goes on alone.
 * - A pointer Android itself calls a palm (FLAG_CANCELED on its POINTER_UP or
 *   CANCEL, from Android 13) cancels the gesture rather than ending it, so it
 *   never becomes a tap.
 * - A contact wider than a fingertip can be (15 mm) is a palm at any time.
 *
 * With no pen about, a finger's touches pass exactly as they came. The page
 * filters too (frontend/src/lib/pen.js); this layer is the stronger one, since
 * it also keeps the WebView from scrolling under a palm.
 */
final class PalmRejection {
    interface Sink { boolean dispatch(MotionEvent e); }

    /** How long after the pen leaves (out of range, or lifted) fingers stay ignored. */
    static final long LINGER_MS = 500;
    /** Wider than this is a palm, pen or no pen. */
    static final float PALM_MM = 15f;
    /** MotionEvent.TOOL_TYPE_PALM, which AOSP has and the public SDK doesn't. */
    private static final int TOOL_TYPE_PALM = 5;

    private final float palmPx;
    private boolean hovering, penDown;
    private long penLeft = Long.MIN_VALUE / 2;
    /** Whether the page has a finger gesture under way, and whether we're swallowing one. */
    private boolean fingerStream, swallowing;
    private MotionEvent lastFinger;

    PalmRejection(DisplayMetrics metrics) {
        palmPx = PALM_MM / 25.4f * metrics.xdpi;
    }

    private boolean penNear() {
        return hovering || penDown || SystemClock.uptimeMillis() - penLeft < LINGER_MS;
    }

    private static boolean isPen(int tool) {
        return tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
    }

    private static boolean anyPen(MotionEvent e) {
        for (int i = 0; i < e.getPointerCount(); i++) if (isPen(e.getToolType(i))) return true;
        return false;
    }

    private boolean palm(MotionEvent e, int i) {
        return e.getToolType(i) == TOOL_TYPE_PALM || e.getTouchMajor(i) > palmPx;
    }

    /** Hover from the pen: it's near from ENTER until EXIT, and a moment after. */
    void hover(MotionEvent e, Sink pass) {
        if (e.getPointerCount() == 0 || !isPen(e.getToolType(0))) return;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_HOVER_ENTER:
            case MotionEvent.ACTION_HOVER_MOVE:
                if (!hovering) {
                    hovering = true;
                    cancelFingers(pass);
                }
                break;
            case MotionEvent.ACTION_HOVER_EXIT:
                hovering = false;
                penLeft = SystemClock.uptimeMillis();
                break;
            default:
                break;
        }
    }

    boolean touch(MotionEvent e, Sink pass) {
        int action = e.getActionMasked();
        boolean pen = anyPen(e);

        if (pen) {
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
                if (!penDown) cancelFingers(pass);
                penDown = true;
            }
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL
                    || (action == MotionEvent.ACTION_POINTER_UP && isPen(e.getToolType(e.getActionIndex())))) {
                penDown = false;
                penLeft = SystemClock.uptimeMillis();
            }
            MotionEvent only = penOnly(e);
            if (only == null) return true;                  // a finger joining or leaving the pen's gesture
            try {
                return pass.dispatch(only);
            } finally {
                if (only != e) only.recycle();
            }
        }

        // Android's own verdict: that pointer was a palm, so nothing it began is a tap
        if (action == MotionEvent.ACTION_POINTER_UP && (e.getFlags() & MotionEvent.FLAG_CANCELED) != 0) {
            cancelFingers(pass);
            swallowing = true;
            return true;
        }

        if (swallowing) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) swallowing = false;
            return true;
        }

        boolean drop = penNear() || palm(e, action == MotionEvent.ACTION_POINTER_DOWN ? e.getActionIndex() : 0);
        if (drop) {
            if (action == MotionEvent.ACTION_DOWN) {
                swallowing = true;                          // the whole gesture, to its end
            } else if (action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL) {
                cancelFingers(pass);
                swallowing = true;
            } else {
                cancelFingers(pass);
            }
            return true;
        }

        // a finger, with no pen about: as it came
        fingerStream = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL;
        if (lastFinger != null) lastFinger.recycle();
        lastFinger = fingerStream ? MotionEvent.obtain(e) : null;
        return pass.dispatch(e);
    }

    /** The page had a finger gesture going: it ends now, as a cancel. */
    private void cancelFingers(Sink pass) {
        if (!fingerStream || lastFinger == null) return;
        MotionEvent cancel = MotionEvent.obtain(lastFinger);
        cancel.setAction(MotionEvent.ACTION_CANCEL);
        try {
            pass.dispatch(cancel);
        } finally {
            cancel.recycle();
            lastFinger.recycle();
            lastFinger = null;
            fingerStream = false;
        }
    }

    /**
     * The event with only the pen's pointers in it; the event itself when
     * there's nothing else; null when it's only about a finger (one joining
     * or leaving the pen's gesture), which the page doesn't need to hear.
     */
    private static MotionEvent penOnly(MotionEvent e) {
        int n = e.getPointerCount(), pens = 0;
        for (int i = 0; i < n; i++) if (isPen(e.getToolType(i))) pens++;
        if (pens == n) return e;
        int action = e.getActionMasked();
        boolean aboutFinger = (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP)
                && !isPen(e.getToolType(e.getActionIndex()));
        if (aboutFinger) return null;

        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[pens];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[pens];
        int newIndex = 0, at = 0;
        for (int i = 0; i < n; i++) {
            if (!isPen(e.getToolType(i))) continue;
            props[at] = new MotionEvent.PointerProperties();
            e.getPointerProperties(i, props[at]);
            coords[at] = new MotionEvent.PointerCoords();
            e.getPointerCoords(i, coords[at]);
            if (i == e.getActionIndex()) newIndex = at;
            at++;
        }
        int newAction = action;
        if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP) {
            if (pens == 1) {
                newAction = action == MotionEvent.ACTION_POINTER_DOWN ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
            } else {
                newAction = action | (newIndex << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            }
        }
        return MotionEvent.obtain(e.getDownTime(), e.getEventTime(), newAction, pens, props, coords,
                e.getMetaState(), e.getButtonState(), e.getXPrecision(), e.getYPrecision(),
                e.getDeviceId(), e.getEdgeFlags(), e.getSource(), e.getFlags());
    }
}
