#!/usr/bin/env node
/**
 * Copy and rename menu images from ULTRA FINAL MENU PICS to public/images/menu/
 * Run with: node scripts/copy-menu-images.js
 */

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '..', 'ULTRA FINAL MENU PICS', 'ULTRA FINAL MENU PICS');
const DEST_DIR = path.join(__dirname, '..', 'burgonomics-foundation-core', 'public', 'images', 'menu');

// Mapping from codebase PHOTOS keys to actual file names in ULTRA FINAL MENU PICS
const IMAGE_MAPPING = {
  // Classic Burgers
  'jr_hero': 'Classic Burgers/Jr. Hero.jpeg',
  'red_hot': 'Classic Burgers/red hot.JPG',
  'hero': 'Classic Burgers/Hero burgr.jpg',
  'mexican_mafia': 'Classic Burgers/Mexican.jpg',
  'korean_kimchi': 'Classic Burgers/Korean Kimchi.JPG',
  'veggie_loaded': 'Classic Burgers/Veggie loaded.jpg',

  // Big Bang Burgers
  'farm_fresh': 'Big Bang/Farm Fresh.jpg',
  'great_indian': 'Big Bang/Great Indian.jpg',
  'cheese_burst': 'Big Bang/Cheese burst.jpg',
  'tandoori_paneer': 'Big Bang/tandoori paneer.jpg',
  'super_hero': 'Big Bang/Super Hero.jpg',
  'burning_man': 'Big Bang/Burning Man.jpeg',

  // Sizzling Burgers (not in source, using placeholders)
  'veg_sizzling': 'Big Bang/Farm Fresh.jpg', // placeholder
  'cheese_supreme_sizzling': 'Big Bang/Cheese burst.jpg', // placeholder
  'paneer_supreme_sizzling': 'Big Bang/tandoori paneer.jpg', // placeholder

  // Fries
  'salted_fries': 'Fries/Salted fries.jpg',
  'peri_peri_fries': 'Fries/Peri peri fries.JPG',
  'peri_peri_cheesy': 'Fries/Peri Peri Cheesy.jpeg',
  'dirty_fries': 'Fries/Dirty fries.jpg',

  // Pizza
  'classic_margherita': 'Pizza/margherita pizza.png',
  'peri_peri_paneer_pizza': 'Pizza/Tandoori paneer pizza.png',
  'veg_overload_pizza': 'Pizza/veggie loaded pizza.jpg',
  'cheesy_heaven_pizza': 'Pizza/4 cheese.png',

  // Pasta
  'alfredo_pasta': 'Pasta/White Sauce.png',
  'arrabiata_pasta': 'Pasta/Pink and Arrabiata.JPG',
  'pink_sauce_pasta': 'Pasta/Pink and Arrabiata.JPG',

  // Garlic Bread
  'cheese_garlic_bread': 'Big Bang/Cheese burst.jpg', // placeholder
  'cheese_corn_garlic_bread': 'Big Bang/Cheese burst.jpg', // placeholder

  // Momos
  'veg_momos_steam': 'Momos/MOMOS.JPG',
  'veg_momos_fried': 'Momos/MOMOS.JPG',
  'spicy_paneer_momos_steam': 'Momos/MOMOS.JPG',
  'spicy_paneer_momos_fried': 'Momos/MOMOS.JPG',
  'veg_cheese_momos_steam': 'Momos/MOMOS.JPG',
  'veg_cheese_momos_fried': 'Momos/MOMOS.JPG',

  // Coolers
  'masala_lemonade': 'Beverages/Lemon Iced Tea.jpg',
  'kokum_drink': 'Beverages/Peach.jpg',
  'masala_coke': 'Beverages/Peach.jpg',
  'blueberry_rosemint_tea': 'Beverages/Peach.jpg',
  'hibiscus_iced_tea': 'Beverages/Lemon Iced Tea.jpg',
  'peach_iced_tea': 'Beverages/Peach.jpg',

  // Thick Shakes
  'cold_coco': 'Shakes/Chocolate.JPG',
  'alfanso_mango_shake': 'Shakes/Chocolate.JPG',
  'cookies_cream_shake': 'Shakes/Cookie Crumble.JPG',
  'brownie_shake': 'Shakes/Chocolate.JPG',
  'ferrero_rocher_shake': 'Shakes/Nutella.JPG',
  'biscoff_shake': 'Shakes/Biscoff Shake.png',
  'tiramisu_cheesecake_shake': 'Shakes/Chocolate.JPG',
  'strawberry_cheesecake_shake': 'Shakes/Strawberry Shake.png',

  // Coffee & Hot Drinks
  'classic_cold_coffee': 'Cold Coffee/Mocha.jpg',
  'mocha_cold_coffee': 'Cold Coffee/Mocha.jpg',
  'irish_cold_coffee': 'Cold Coffee/Irish.jpg',
  'hazelnut_cold_coffee': 'Cold Coffee/Hazelnut.jpg',
  'americano': 'Cold Coffee/Mocha.jpg',
  'cappuccino': 'Cold Coffee/Mocha.jpg',
  'latte': 'Cold Coffee/Mocha.jpg',
  'mocha_hot': 'Cold Coffee/Mocha.jpg',
  'hot_chocolate': 'Shakes/Chocolate.JPG',
  'jaggery_hot_chocolate': 'Shakes/Chocolate.JPG',

  // Desserts
  'chocolate_brownie': 'Brownie/Chocolate Brownie.png',

  // Combos
  'combo_jr_cooler': 'Meals/Strawberry shake + Veggie loaded burger.png',
  'combo_jr_meal': 'Meals/hero meal.JPG',
  'combo_classic_meal': 'Meals/hero meal.JPG',
  'combo_great_indian_meal': 'Meals/big bang meal.JPG',
  'combo_big_bang_meal': 'Meals/big bang meal.JPG',
  'combo_cheese_burst': 'Meals/coke + cheese burst.png',
  'combo_kimchi_coffee': 'Meals/Kimchi + coffee.png',
  'combo_red_hot_meal': 'Meals/Red Hot meal.jpg',
  'combo_shake_burger': 'Meals/Strawberry shake + Veggie loaded burger.png',
};

function copyImages() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  if (!fs.existsSync(DEST_DIR)) {
    fs.mkdirSync(DEST_DIR, { recursive: true });
  }

  let copied = 0;
  let missing = 0;

  for (const [key, sourcePath] of Object.entries(IMAGE_MAPPING)) {
    const sourceFile = path.join(SOURCE_DIR, sourcePath);
    const destFile = path.join(DEST_DIR, `${key}.jpg`);

    // Create subdirectories if needed
    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(sourceFile)) {
      fs.copyFileSync(sourceFile, destFile);
      console.log(`✓ Copied: ${sourcePath} -> ${key}.jpg`);
      copied++;
    } else {
      console.log(`✗ Missing: ${sourcePath} (for ${key})`);
      missing++;
    }
  }

  console.log(`\nDone! Copied: ${copied}, Missing: ${missing}`);
}

copyImages();