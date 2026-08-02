#!/bin/bash
# Replaces electron-builder's default deb postinst.
#
# The stock template decides chrome-sandbox permissions by testing
# `unshare --user` as root at install time — but root can always create a
# user namespace, so on Ubuntu 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1)
# it wrongly concludes the namespace sandbox will work and leaves the helper
# non-setuid. Regular users then cannot launch the app at all. We test the
# restriction directly and fall back to the SUID sandbox, which is what
# Google Chrome's own .deb ships.

set -e

APP_DIR='/opt/${sanitizedProductName}'
SANDBOX="${APP_DIR}/chrome-sandbox"

# Link the executable onto PATH.
ln -sf "${APP_DIR}/${executable}" '/usr/bin/${executable}'

if [ -f "$SANDBOX" ]; then
  RESTRICTED=0
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    RESTRICTED=1
  elif ! unshare --user true 2>/dev/null; then
    RESTRICTED=1
  fi

  if [ "$RESTRICTED" = "1" ]; then
    # Without this the app cannot sandbox itself and refuses to start, so a
    # failure here must be visible rather than silently swallowed.
    if ! chown root:root "$SANDBOX" || ! chmod 4755 "$SANDBOX"; then
      echo "WARNING: could not make $SANDBOX setuid root." >&2
      echo "         Gloss will not start until this is fixed:" >&2
      echo "           sudo chown root:root $SANDBOX && sudo chmod 4755 $SANDBOX" >&2
    fi
  else
    chmod 0755 "$SANDBOX" || true
  fi
fi

# Refresh desktop/MIME caches so the PDF association takes effect.
if hash update-mime-database 2>/dev/null; then
  update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi
if hash gtk-update-icon-cache 2>/dev/null; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
