// Added by phonectl (Apache-2.0).
package com.genymobile.scrcpy.video;

/**
 * Bytes the kernel has accepted on the video socket but not yet sent, or -1 if unknown.
 *
 * <p>A write() returns as soon as the data fits in the TCP send buffer, which Linux auto-tunes up to megabytes. On a slow link
 * that buffer, not the sender queue, is where seconds of video pile up, so the sender must look at it before writing more.
 */
public interface BacklogProbe {
    BacklogProbe NONE = () -> -1;

    int unsentBytes();
}
