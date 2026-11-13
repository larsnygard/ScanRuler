// SPDX-License-Identifier: AGPL-3.0-only
// What the imprint owes the CAD kernel this workspace ships.

export function CadNotices() {
  return (
    <p>
      The CAD workspace models with{' '}
      <a href="https://dev.opencascade.org/" target="_blank" rel="noopener noreferrer">
        Open CASCADE Technology
      </a>{' '}
      (OCCT, © Open Cascade SAS), licensed under the GNU LGPL 2.1 with the Open CASCADE exception,
      compiled to WebAssembly by{' '}
      <a href="https://github.com/andymai/occt-wasm" target="_blank" rel="noopener noreferrer">
        occt-wasm
      </a>{' '}
      (MIT / Apache-2.0). The kernel is loaded as a separate file when that workspace is opened and
      is not otherwise part of this application; OCCT is used unmodified, and its source is
      available from the project linked above.
    </p>
  )
}
