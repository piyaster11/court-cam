# COURT CAM

Live sports-broadcast HUD over your iPhone camera — **badminton, tennis, football**.

**Open on iPhone (Safari):** https://piyaster11.github.io/court-cam/ → Share → *Add to Home Screen* for full-screen.

- Live rear camera + on-device person tracking (MediaPipe Tasks Vision, runs 100% in the browser, nothing uploaded)
- Player tags with name / rating, glowing floor rings, LOCK ON reticle on the hitter
- Rally time & count (tap controls, optional mic hit detection), shot / ball speed (**est.**)
- Distance + stamina per player, court / pitch mini-map
- 4-tap court calibration (homography) for better distance and speed
- Tennis & football: ball tracking (detector + motion/colour tracker) with trail and speed popup; football possession (est.)
- REC: records the composited video + HUD (+ mic) to MP4 and saves via the iOS share sheet

**Best results:** phone on a tripod, fixed, side-on, whole court in view, then Menu › Calibrate.

All speeds, distances, stamina and possession are **estimates** from a single phone camera.

Third-party: MediaPipe Tasks Vision (Apache-2.0), EfficientDet-Lite0 / Pose Landmarker Lite models (Apache-2.0), Chakra Petch font (SIL OFL 1.1).
