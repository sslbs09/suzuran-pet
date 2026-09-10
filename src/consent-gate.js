"use strict";

/**
 * Consent is intentionally boolean, not truthy.  Missing, malformed, and
 * every value other than the literal true remain pending.
 */
function isConsentAccepted(config) {
  return !!config && config.agreed === true;
}

function canUseRuntime(config) {
  return isConsentAccepted(config);
}

/**
 * Persist consent first, then verify it through the real config reader before
 * the caller changes any local/UI state or starts the normal runtime.
 */
function acceptConsent({ saveConfig, readConfig }) {
  saveConfig({ agreed: true });
  if (!isConsentAccepted(readConfig())) {
    const error = new Error("consent save could not be confirmed");
    error.code = "CONSENT_SAVE_UNCONFIRMED";
    throw error;
  }
  return true;
}

module.exports = { isConsentAccepted, canUseRuntime, acceptConsent };
