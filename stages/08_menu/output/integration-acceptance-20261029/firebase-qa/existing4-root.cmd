@echo off
cd /d "C:\Users\DELL\Desktop\Burgonomics\stages\08_menu\output\integration-acceptance-20261029\firebase-qa\temp-rules-suite"
copy /Y "C:\Users\DELL\Desktop\Burgonomics\firestore.rules" "firestore.rules" >nul
set CI=true
set FIRESTORE_EMULATOR_PORT=8166
set RULES_SRC=
call "C:\Users\DELL\Desktop\Burgonomics\burgonomics-foundation-core\node_modules\.bin\vitest.cmd" run --config vitest.config.ts

