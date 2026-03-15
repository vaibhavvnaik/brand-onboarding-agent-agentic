/**
 * fix-encoding.js - Runs before app start to fix non-ASCII chars in source files.
 * Needed because files were committed via web editor with encoding corruption.
 */
const fs = require('fs');
const path = require('path');

const DIRS = ['agents', 'config', 'middleware', 'models', 'routes', 'services', 'utils', 'public/dashboard'];
const EXTS = ['.js', '.html'];

function walkDir(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        results = results.concat(walkDir(filePath));
      } else if (EXTS.some(ext => file.endsWith(ext))) {
        results.push(filePath);
      }
    }
  } catch (e) { /* skip inaccessible dirs */ }
  return results;
}

function fixContent(content) {
  // Replace any non-ASCII byte with closest ASCII equivalent
  let fixed = content;
  // Common mojibake patterns (UTF-8 bytes misread as latin-1)
  const replacements = [
    [/\u00e2\u0080\u0099/g, "'"],    // smart quote right
    [/\u00e2\u0080\u0098/g, "'"],    // smart quote left
    [/\u00e2\u0080\u009c/g, '"'],    // smart double quote left
    [/\u00e2\u0080\u009d/g, '"'],    // smart double quote right
    [/\u00e2\u0080\u0094/g, '-'],    // em dash
    [/\u00e2\u0080\u0093/g, '-'],    // en dash
    [/\u00e2\u0080\u00a6/g, '...'],  // ellipsis
    [/\u00e2\u0094\u0080/g, '-'],    // box drawing horizontal
    [/\u00e2\u0094\u0082/g, '|'],    // box drawing vertical
    [/\u00e2\u0086\u0092/g, '->'],   // right arrow
    [/\u00e2\u0086\u0090/g, '<-'],   // left arrow
    [/\u00e2\u009c\u0085/g, '[OK]'], // checkmark
    [/\u00e2\u009d\u008c/g, '[ERR]'],// cross mark
    [/\u00e2\u008f\u00b3/g, '[...]'],// hourglass
    [/\u00e2\u0084\u00b9/g, '[i]'],  // info
    [/\u00c3\u0097/g, 'x'],          // multiplication sign
    [/\u00c3\u00a9/g, 'e'],          // e acute
    [/\u00e2\u009a\u00a0/g, '[WARN]'], // warning
    [/\u00e2\u0080\u00a2/g, '*'],    // bullet
  ];
  for (const [pattern, replacement] of replacements) {
    fixed = fixed.replace(pattern, replacement);
  }
  // Strip any remaining non-ASCII characters
  fixed = fixed.replace(/[^\x00-\x7F]/g, '');
  return fixed;
}

let totalFixed = 0;
for (const dir of DIRS) {
  const fullDir = path.join(__dirname, dir);
  const files = walkDir(fullDir);
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fixed = fixContent(content);
      if (fixed !== content) {
        fs.writeFileSync(filePath, fixed, 'utf8');
        totalFixed++;
        console.log('Fixed encoding:', path.relative(__dirname, filePath));
      }
    } catch (e) {
      console.error('Error fixing', filePath, e.message);
    }
  }
}
// Also fix index.js
try {
  const indexPath = path.join(__dirname, 'index.js');
  const content = fs.readFileSync(indexPath, 'utf8');
  const fixed = fixContent(content);
  if (fixed !== content) {
    fs.writeFileSync(indexPath, fixed, 'utf8');
    totalFixed++;
    console.log('Fixed encoding: index.js');
  }
} catch (e) { /* already fixed */ }

console.log('Encoding fix complete.', totalFixed, 'files updated.');
