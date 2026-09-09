// ROOMTONE — audio-reactive room lighting for Windows.
// Copyright (C) 2026 Robin
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details. You should have received a copy of the licence along with
// this program. If not, see <https://www.gnu.org/licenses/>.

// Parsing the shader header.
//
// A preset is a .frag file and nothing else. The comment block at the top
// declares its name and its tweakable parameters, and the app builds the
// settings sliders from that — no registration step, no JSON sidecar, no code
// change to add a preset. Drop a file in the folder and it appears.
//
//   // @name      Warp Tunnel
//   // @author    yourname
//   // @param     depth    0.0 .. 4.0  = 1.2   "Tunnel depth"
//   // @feedback  true

const NAME = /^\s*\/\/\s*@name\s+(.+?)\s*$/m;
const AUTHOR = /^\s*\/\/\s*@author\s+(.+?)\s*$/m;
const FEEDBACK = /^\s*\/\/\s*@feedback\s+(\w+)\s*$/m;
const PARAM =
  /^\s*\/\/\s*@param\s+(\w+)\s+(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*=\s*(-?[\d.]+)\s*(?:"([^"]*)")?\s*$/gm;

/** Turn a filename into a readable label if the file has no @name. */
function labelFromFile(file) {
  return file
    .replace(/\.frag$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parsePreset({ file, source, kind, mtime }) {
  const params = [];
  PARAM.lastIndex = 0;
  let m;
  while ((m = PARAM.exec(source)) !== null) {
    const [, key, min, max, value, label] = m;
    params.push({
      key,
      label: label || key,
      min: parseFloat(min),
      max: parseFloat(max),
      value: parseFloat(value),
      // A sensible step: 200 divisions across the range, rounded to something
      // that reads well in the readout.
      step: niceStep(parseFloat(min), parseFloat(max)),
    });
  }

  return {
    file,
    kind,
    mtime,
    source,
    id: file.replace(/\.frag$/i, ''),
    name: (source.match(NAME) || [])[1] || labelFromFile(file),
    author: (source.match(AUTHOR) || [])[1] || null,
    feedback: ((source.match(FEEDBACK) || [])[1] || 'false').toLowerCase() === 'true',
    params,
  };
}

function niceStep(min, max) {
  const span = Math.abs(max - min);
  if (span >= 100) return 1;
  if (span >= 10) return 0.5;
  if (span >= 3) return 0.05;
  return 0.01;
}
