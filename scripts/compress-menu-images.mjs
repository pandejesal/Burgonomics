import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sharp = require('../burgonomics-foundation-core/node_modules/sharp');

const targetDirs = [
  path.resolve('burgonomics-foundation-core/public/images/menu'),
  path.resolve('burgonomics-partner/public/images/menu')
];

async function optimizeDir(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`Directory does not exist: ${dir}`);
    return;
  }
  
  console.log(`\nProcessing: ${dir}`);
  const files = fs.readdirSync(dir);
  let beforeTotal = 0;
  let afterTotal = 0;
  
  for (const file of files) {
    if (!/\.(jpe?g|png)$/i.test(file)) continue;
    
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    beforeTotal += stat.size;
    
    try {
      const buffer = fs.readFileSync(fullPath);
      // Resize to max 1200x1200, fit inside, high-quality jpeg at 82%
      const optimized = await sharp(buffer)
        .rotate() // auto rotate based on EXIF
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, progressive: true, mozjpeg: true })
        .toBuffer();
        
      if (optimized.length < stat.size) {
        fs.writeFileSync(fullPath, optimized);
        afterTotal += optimized.length;
        console.log(`✓ ${file}: ${(stat.size / 1024).toFixed(0)}KB -> ${(optimized.length / 1024).toFixed(0)}KB (-${Math.round((1 - optimized.length / stat.size) * 100)}%)`);
      } else {
        afterTotal += stat.size;
        console.log(`= ${file}: kept original (${(stat.size / 1024).toFixed(0)}KB)`);
      }
    } catch (err) {
      console.error(`✗ Error optimizing ${file}:`, err.message);
      afterTotal += stat.size;
    }
  }
  
  console.log(`\nResult for ${path.basename(path.dirname(dir))}: ${(beforeTotal / (1024 * 1024)).toFixed(2)} MB -> ${(afterTotal / (1024 * 1024)).toFixed(2)} MB (-${Math.round((1 - afterTotal / beforeTotal) * 100)}%)`);
}

async function run() {
  for (const dir of targetDirs) {
    await optimizeDir(dir);
  }
  console.log('\nAll image optimizations complete!');
}

run();
