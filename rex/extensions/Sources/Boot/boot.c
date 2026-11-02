#include "include/Boot.h"

#include <dispatch/dispatch.h>
#include <stdlib.h>

static void start(void *context) { rex_extensions_start(); }

// Swift has no load-time hook, so dyld runs this when Rex loads the dylib.
// AppKit is not up yet, so start on the main queue.
__attribute__((constructor)) static void boot(void) {
  if (getenv("REX_EXTENSIONS_DISABLE") != NULL)
    return;
  dispatch_async_f(dispatch_get_main_queue(), NULL, start);
}
