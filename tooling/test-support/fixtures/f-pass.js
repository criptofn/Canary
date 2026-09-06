// Test fixture: a project check that passes silently.
// Referenced by absolute path from onboarding.test.ts / probes so tests never
// build programs from inline `node -e` strings (approval-free workflow rule).
process.exit(0);
