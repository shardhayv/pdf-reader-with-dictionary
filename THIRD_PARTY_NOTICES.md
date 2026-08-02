# Third-party notices

Gloss is created and maintained by **Shardhay Vatshyayan** and is licensed
under the GNU Affero General Public License v3.0 only. Its runtime is built on
the following open-source projects, which retain their own copyrights and
licenses.

| Component | Version in Gloss 2.1.1 | License | Project |
|---|---:|---|---|
| js-mdict | 7.0.0 | AGPL-3.0 | <https://github.com/terasum/js-mdict> |
| DOMPurify | 3.4.12 | MPL-2.0 OR Apache-2.0 | <https://github.com/cure53/DOMPurify> |
| PDF.js (`pdfjs-dist`) | 4.10.38 | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| Electron | 33.4.11 | MIT | <https://github.com/electron/electron> |

The source checkout also uses build and test tooling, including
electron-builder (MIT), Playwright (Apache-2.0), ESLint (MIT), and their
transitive dependencies. Exact versions and package-declared licenses are
recorded in `package-lock.json` and the installed packages' license files.

Electron packages include Electron and Chromium license notices in the built
application. Gloss does not modify or claim ownership of these dependencies.

## Dictionary content

Gloss bundles no MDX, MDD, PDF, Wikipedia, or generated glossary content in its
source or release packages. Files a reader loads remain separate works and are
governed by their respective owners' terms. Test PDFs are generated locally by
the repository's fixture scripts and are excluded from Git.
