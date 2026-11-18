# Third-party notices

This project builds against, and adapts code from, Chainlink's Data Streams Canton integration.

## Chainlink Data Streams Canton

- Source: https://github.com/smartcontractkit/data-streams-canton (release `v1.0.0`)
- License: MIT

The compiled contracts (`verifier`, `verifier-config`, `domain`, `common`) are **not** redistributed
in this repository; they are downloaded from the official release at build time (see
`scripts/fetch-dars.sh` and the README).

In addition, the following modules in `oracle-chainlink/` are **adapted** from the examples in
that project and are therefore covered by its MIT license:

- `Palladium.Oracle.Chainlink.ReportDataV3` (adapted from the V3 report decoding examples)
- `Palladium.Oracle.Chainlink.HexToDecimal` (adapted from the hex-to-decimal helpers)

The MIT license text for that work is reproduced below.

```
MIT License

Copyright (c) 2018 SmartContract ChainLink Limited SEZC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
