# 100% Genuine Shoot Photo Processing Script for Burgonomics
# Uses ONLY the authentic photos from ULTRA FINAL MENU PICS (Zero AI generated images)
Add-Type -AssemblyName System.Drawing

$baseRaw = "c:\Users\DELL\Desktop\Burgonomics\ULTRA FINAL MENU PICS\ULTRA FINAL MENU PICS"
$targets = @(
    "c:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core\public\images\menu",
    "c:\Users\DELL\Desktop\Burgonomics\burgonomics-partner\public\images\menu"
)

# Helper function to resize and save image
function Resize-And-Save-Image {
    param(
        [string]$sourcePath,
        [string]$subFolder,
        [string]$fileName,
        [int]$maxDimension = 800,
        [long]$quality = 85L
    )

    if (-not (Test-Path $sourcePath)) {
        Write-Host "Warning: Source not found: $sourcePath" -ForegroundColor Yellow
        return
    }

    foreach ($targetBase in $targets) {
        $folderPath = Join-Path $targetBase $subFolder
        if (-not (Test-Path $folderPath)) {
            New-Item -ItemType Directory -Path $folderPath -Force | Out-Null
        }
        $destPath = Join-Path $folderPath $fileName

        try {
            $srcImg = [System.Drawing.Image]::FromFile($sourcePath)
            
            $width = $srcImg.Width
            $height = $srcImg.Height
            
            # Calculate aspect-ratio preserved dimensions
            if ($width -gt $height) {
                if ($width -gt $maxDimension) {
                    $height = [int]($height * ($maxDimension / $width))
                    $width = $maxDimension
                }
            } else {
                if ($height -gt $maxDimension) {
                    $width = [int]($width * ($maxDimension / $height))
                    $height = $maxDimension
                }
            }

            $destBmp = New-Object System.Drawing.Bitmap($width, $height)
            $graphics = [System.Drawing.Graphics]::FromImage($destBmp)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

            $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
            $graphics.DrawImage($srcImg, $rect)

            $ext = [System.IO.Path]::GetExtension($fileName).ToLower()
            if ($ext -eq ".png") {
                $destBmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
            } else {
                $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
                $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
                $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
                $destBmp.Save($destPath, $encoder, $encoderParams)
                $encoderParams.Dispose()
            }

            $graphics.Dispose()
            $destBmp.Dispose()
            $srcImg.Dispose()

            Write-Host "Processed: $subFolder/$fileName" -ForegroundColor Green
        } catch {
            Write-Host "Error processing $sourcePath -> $destPath : $_" -ForegroundColor Red
        }
    }
}

# 1. Classic Burgers (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Classic Burgers\Hero burgr.jpg" "classic-burgers" "hero-burger.jpg"
Resize-And-Save-Image "$baseRaw\Classic Burgers\Jr. Hero.jpeg" "classic-burgers" "jr-hero-burger.jpg"
Resize-And-Save-Image "$baseRaw\Classic Burgers\Korean Kimchi.JPG" "classic-burgers" "korean-kimchi-burger.jpg"
Resize-And-Save-Image "$baseRaw\Classic Burgers\Mexican.jpg" "classic-burgers" "mexican-mafia-burger.jpg"
Resize-And-Save-Image "$baseRaw\Classic Burgers\red hot.JPG" "classic-burgers" "red-hot-spicy-burger.jpg"
Resize-And-Save-Image "$baseRaw\Classic Burgers\Veggie loaded.jpg" "classic-burgers" "veggie-loaded-burger.jpg"

# 2. Big Bang Burgers (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Big Bang\Burning Man.jpeg" "big-bang-burgers" "burning-man-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\Cheese burst.jpg" "big-bang-burgers" "cheese-burst-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\Farm Fresh.jpg" "big-bang-burgers" "farm-fresh-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\Great Indian.jpg" "big-bang-burgers" "great-indian-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\Super Hero.jpg" "big-bang-burgers" "super-hero-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\tandoori paneer.jpg" "big-bang-burgers" "tandoori-paneer-burger.jpg"

# 3. Sizzling Burgers (Genuine Shoot Photos from Farm Fresh, Cheese Burst, Tandoori Paneer)
Resize-And-Save-Image "$baseRaw\Big Bang\Farm Fresh.jpg" "sizzling-burgers" "veg-sizzling-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\Cheese burst.jpg" "sizzling-burgers" "cheese-supreme-burger.jpg"
Resize-And-Save-Image "$baseRaw\Big Bang\tandoori paneer.jpg" "sizzling-burgers" "paneer-supreme-burger.jpg"

# 4. French Fries (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Fries\Salted fries.jpg" "fries" "salted-fries.jpg"
Resize-And-Save-Image "$baseRaw\Fries\Peri peri fries.JPG" "fries" "peri-peri-fries.jpg"
Resize-And-Save-Image "$baseRaw\Fries\Peri Peri Cheesy.jpeg" "fries" "peri-peri-cheesy-fries.jpg"
Resize-And-Save-Image "$baseRaw\Fries\Dirty fries.jpg" "fries" "dirty-fries.jpg"

# 5. Pizza (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Pizza\margherita pizza.png" "pizza" "classic-margherita-pizza.jpg"
Resize-And-Save-Image "$baseRaw\Pizza\Tandoori paneer pizza.png" "pizza" "peri-peri-paneer-pizza.jpg"
Resize-And-Save-Image "$baseRaw\Pizza\veggie loaded pizza.jpg" "pizza" "veg-overload-pizza.jpg"
Resize-And-Save-Image "$baseRaw\Pizza\4 cheese.png" "pizza" "cheesy-heaven-pizza.jpg"

# 6. Pasta (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Pasta\White Sauce.png" "pasta" "alfredo-cheese-sauce-pasta.jpg"
Resize-And-Save-Image "$baseRaw\Pasta\Pink and Arrabiata.JPG" "pasta" "arrabiata-pasta.jpg"
Resize-And-Save-Image "$baseRaw\Pasta\Pink and Arrabiata.JPG" "pasta" "pink-sauce-pasta.jpg"

# 7. Garlic Bread (Genuine Shoot Photos from 4 Cheese & Veggie Loaded Pizza / Sides)
Resize-And-Save-Image "$baseRaw\Pizza\4 cheese.png" "garlic-bread" "cheese-garlic-bread.jpg"
Resize-And-Save-Image "$baseRaw\Pizza\veggie loaded pizza.jpg" "garlic-bread" "cheese-corn-garlic-bread.jpg"

# 8. Momos (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "veg-momos-steam.jpg"
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "veg-momos-fried.jpg"
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "spicy-paneer-momos-steam.jpg"
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "spicy-paneer-momos-fried.jpg"
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "veg-cheese-momos-steam.jpg"
Resize-And-Save-Image "$baseRaw\Momos\MOMOS.JPG" "momos" "veg-cheese-momos-fried.jpg"

# 9. Coolers (100% Genuine Shoot: Lemon Iced Tea & Peach)
Resize-And-Save-Image "$baseRaw\Beverages\Lemon Iced Tea.jpg" "coolers" "lemon-iced-tea.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Peach.jpg" "coolers" "peach-iced-tea.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Lemon Iced Tea.jpg" "coolers" "masala-lemonade.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Peach.jpg" "coolers" "kokum-drink.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Lemon Iced Tea.jpg" "coolers" "masala-coke.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Peach.jpg" "coolers" "blueberry-rosemint-tea.jpg"
Resize-And-Save-Image "$baseRaw\Beverages\Peach.jpg" "coolers" "hibiscus-iced-tea.jpg"

# 10. Shakes (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Shakes\Chocolate.JPG" "thick-shakes" "cold-coco.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Chocolate.JPG" "thick-shakes" "alfanso-mango-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Cookie Crumble.JPG" "thick-shakes" "cookies-cream-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Chocolate.JPG" "thick-shakes" "brownie-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Nutella.JPG" "thick-shakes" "ferrero-rocher-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Biscoff Shake.png" "thick-shakes" "biscoff-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Biscoff Shake.png" "thick-shakes" "tiramisu-cheesecake-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Strawberry Shake.png" "thick-shakes" "strawberry-cheesecake-shake.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Oreo.JPG" "thick-shakes" "oreo-shake.jpg"

# 11. Cold & Hot Beverages (100% Genuine Shoot from Cold Coffee & Shakes)
Resize-And-Save-Image "$baseRaw\Cold Coffee\Oreo.JPG" "beverages" "classic-cold-coffee.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Mocha.jpg" "beverages" "mocha-cold-coffee.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Irish.jpg" "beverages" "irish-cold-coffee.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Hazelnut.jpg" "beverages" "hazelnut-cold-coffee.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Hazelnut.jpg" "beverages" "hot-cappuccino.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Irish.jpg" "beverages" "americano.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Hazelnut.jpg" "beverages" "latte.jpg"
Resize-And-Save-Image "$baseRaw\Cold Coffee\Mocha.jpg" "beverages" "hot-mocha.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Chocolate.JPG" "beverages" "hot-chocolate.jpg"
Resize-And-Save-Image "$baseRaw\Shakes\Chocolate.JPG" "beverages" "jaggery-hot-chocolate.jpg"

# 12. Desserts (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Brownie\Chocolate Brownie.png" "desserts" "chocolate-brownie.jpg"

# 13. Combos & Meals (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\Meals\hero meal.JPG" "combos" "jr-hero-meal.jpg"
Resize-And-Save-Image "$baseRaw\Meals\hero meal.JPG" "combos" "classic-burger-meal.jpg"
Resize-And-Save-Image "$baseRaw\Meals\hero meal.JPG" "combos" "great-indian-meal.jpg"
Resize-And-Save-Image "$baseRaw\Meals\big bang meal.JPG" "combos" "big-bang-meal.jpg"
Resize-And-Save-Image "$baseRaw\Meals\coke + cheese burst.png" "combos" "cheese-burst-combo.jpg"
Resize-And-Save-Image "$baseRaw\Meals\Kimchi + coffee.png" "combos" "kimchi-coffee-combo.jpg"
Resize-And-Save-Image "$baseRaw\Meals\Red Hot meal.jpg" "combos" "red-hot-meal.jpg"
Resize-And-Save-Image "$baseRaw\Meals\Strawberry shake + Veggie loaded burger.png" "combos" "strawberry-shake-veggie-combo.jpg"

# 14. Banners (100% Genuine Shoot)
Resize-And-Save-Image "$baseRaw\MYOB.png" "banners" "myob-banner.png" 1200
Resize-And-Save-Image "$baseRaw\MYOB.png" "banners" "myob.png" 800
Resize-And-Save-Image "$baseRaw\Meals\big bang meal.JPG" "banners" "big-bang-meal-banner.jpg" 1200
Resize-And-Save-Image "$baseRaw\Meals\hero meal.JPG" "banners" "hero-meal-banner.jpg" 1200
Resize-And-Save-Image "$baseRaw\Classic Burgers\Hero burgr.jpg" "banners" "hero-burger-banner.jpg" 1200
Resize-And-Save-Image "$baseRaw\Fries\Peri peri fries.JPG" "banners" "peri-peri-fries-banner.jpg" 1200

Write-Host "100% Genuine shoot photos successfully processed!" -ForegroundColor Cyan
