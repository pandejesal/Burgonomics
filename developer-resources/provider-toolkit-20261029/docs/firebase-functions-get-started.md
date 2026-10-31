# Official Cloud Functions get-started documentation

Source: https://firebase.google.com/docs/functions/get-started
Retrieved UTC: 2026-10-29T11:18:55.507017+00:00
Retrieval method: static

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Firebase
Documentation
Cloud Functions
Build
Send feedback
Get started: write, test, and deploy your first functions
Stay organized with collections
Save and categorize content based on your preferences.
To get started with
Cloud Functions
, try working through this tutorial,
which starts with the required setup tasks and works through creating, testing,
and deploying two related functions:
An "add message" function that exposes a URL that accepts a text value and writes it
to
Cloud Firestore
.
A "make uppercase" function that triggers on a
Cloud Firestore
write and transforms
the text to uppercase.
Here's the full sample code containing the functions:
Node.js
// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
const
{
logger
}
=
require
(
"firebase-functions"
);
const
{
onRequest
}
=
require
(
"firebase-functions/https"
);
const
{
onDocumentCreated
}
=
require
(
"firebase-functions/firestore"
);
// The Firebase Admin SDK to access Firestore.
const
{
initializeApp
}
=
require
(
"firebase-admin/app"
);
const
{
getFirestore
}
=
require
(
"firebase-admin/firestore"
);
initializeApp
();
// Take the text parameter passed to this HTTP endpoint and insert it into
// Firestore under the path /messages/:documentId/original
exports
.
addmessage
=
onRequest
(
async
(
req
,
res
)
=
>
{
// Grab the text parameter.
const
original
=
req
.
query
.
text
;
// Push the new message into Firestore using the Firebase Admin SDK.
const
writeResult
=
await
getFirestore
()
.
collection
(
"messages"
)
.
add
({
original
:
original
});
// Send back a message that we've successfully written the message
res
.
json
({
result
:
`Message with ID:
${
writeResult
.
id
}
added.`
});
});
// Listens for new messages added to /messages/:documentId/original
// and saves an uppercased version of the message
// to /messages/:documentId/uppercase
exports
.
makeuppercase
=
onDocumentCreated
(
"/messages/{documentId}"
,
(
event
)
=
>
{
// Grab the current value of what was written to Firestore.
const
original
=
event
.
data
.
data
().
original
;
// Access the parameter `{documentId}` with `event.params`
logger
.
log
(
"Uppercasing"
,
event
.
params
.
documentId
,
original
);
const
uppercase
=
original
.
toUpperCase
();
// You must return a Promise when performing
// asynchronous tasks inside a function
// such as writing to Firestore.
// Setting an 'uppercase' field in Firestore document returns a Promise.
return
event
.
data
.
ref
.
set
({
uppercase
},
{
merge
:
true
});
});
index
.
js
Python
# The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
from
firebase_functions
import
firestore_fn
,
https_fn
# The Firebase Admin SDK to access Cloud Firestore.
from
firebase_admin
import
initialize_app
,
firestore
import
google.cloud.firestore
app
=
initialize_app
()
@https_fn
.
on_request
()
def
addmessage
(
req
:
https_fn
.
Request
)
-
>
https_fn
.
Response
:
"""Take the text parameter passed to this HTTP endpoint and insert it into
a new document in the messages collection."""
# Grab the text parameter.
original
=
req
.
args
.
get
(
"text"
)
if
original
is
None
:
return
https_fn
.
Response
(
"No text parameter provided"
,
status
=
400
)
firestore_client
:
google
.
cloud
.
firestore
.
Client
=
firestore
.
client
()
# Push the new message into Cloud Firestore using the Firebase Admin SDK.
_
,
doc_ref
=
firestore_client
.
collection
(
"messages"
)
.
add
({
"original"
:
original
})
# Send back a message that we've successfully written the message
return
https_fn
.
Response
(
f
"Message with ID
{
doc_ref
.
id
}
added."
)
@firestore_fn
.
on_document_created
(
document
=
"messages/
{pushId}
"
)
def
makeuppercase
(
event
:
firestore_fn
.
Event
[
firestore_fn
.
DocumentSnapshot
|
None
])
-
>
None
:
"""Listens for new documents to be added to /messages. If the document has
an "original" field, creates an "uppercase" field containg the contents of
"original" in upper case."""
# Get the value of "original" if it exists.
if
event
.
data
is
None
:
return
try
:
original
=
event
.
data
.
get
(
"original"
)
except
KeyError
:
# No "original" field, so do nothing.
return
# Set the "uppercase" field.
print
(
f
"Uppercasing
{
event
.
params
[
'pushId'
]
}
:
{
original
}
"
)
upper
=
original
.
upper
()
event
.
data
.
reference
.
update
({
"uppercase"
:
upper
})
main
.
py
About this tutorial
We've chosen
Cloud Firestore
and HTTP-triggered functions for this
sample in part because these background triggers can be thoroughly tested
through the
Firebase Local Emulator Suite
. This toolset
also supports
Realtime Database
,
Cloud Storage
,
PubSub, Auth, and HTTP callable triggers. Other types of background triggers
such as
Remote Config
and TestLab triggers can be
tested interactively
using toolsets not
described in this page.
Note:
You can emulate functions in any Firebase project, but to deploy
functions, your project
must be on the
Blaze pricing plan
. See
Cloud Functions
pricing
.
The following sections of this tutorial detail the steps required to build,
test, and deploy the sample.
Create a Firebase Project
New to Firebase or Cloud
Follow these steps if you're new to Firebase or
Google Cloud
.
You can also follow these steps if you want to create a wholly new
      Firebase project (and its underlying
Google Cloud
project).
Sign into the
Firebase
console
.
Click the button to create a new Firebase project.
In the text field, enter a
project name
.
If you're part of a
Google Cloud
org, you can optionally select which
          folder you create your project in.
Your project name is used as a display name in
          Firebase interfaces, and Firebase auto-creates a unique project ID
          based on this project name. Note that you can optionally click the
Edit
icon now to set your preferred project ID, but you cannot
          change this ID after project creation. Learn about
how Firebase uses the
            project ID
.
If prompted, review and accept the
Firebase terms
,
        then click
Continue
.
(Optional)
Enable AI assistance in the
Firebase
console
        (called "Gemini in Firebase"), which can help you get started and
        streamline your development process.
(Optional)
Set up
Google Analytics
for your project,
          which enables an optimal experience using these Firebase products:
Firebase A/B Testing
,
Cloud Messaging
,
Crashlytics
,
In-App Messaging
, and
Remote Config
(including
Personalization
).
Either select an existing
Google Analytics
account
or create a new account. If you create a new account, select your
Analytics
reporting location
,
          then accept the data sharing settings and
Google Analytics
terms
          for your project.
You can always set up
Google Analytics
later
          in the
Integrations
tab
of your
settings
Project settings
.
Click
Create project
.
Firebase creates your project, provisions some initial resources, and
      enables important APIs. When the process completes, you'll be taken to the
      overview page for your Firebase project in the
Firebase
console.
Existing Cloud project
Follow these steps if you want to start using Firebase with an existing
Google Cloud
project. Learn more about and troubleshoot
"adding
        Firebase" to an existing
Google Cloud
project
.
Sign into the
Firebase
console
with the account that gives
        you access to the existing
Google Cloud
project.
Click the button to create a new Firebase project.
At the bottom of the page, click
Add Firebase to Google Cloud project
.
In the text field, start entering the
project name
of the
        existing project, and then select the project from the displayed list.
Click
Open project
.
If prompted, review and accept the
Firebase terms
,
        then click
Continue
.
(Optional)
Enable AI assistance in the
Firebase
console
        (called "Gemini in Firebase"), which can help you get started and
        streamline your development process.
(Optional)
Set up
Google Analytics
for your project,
          which enables an optimal experience using these Firebase products:
Firebase A/B Testing
,
Cloud Messaging
,
Crashlytics
,
In-App Messaging
, and
Remote Config
(including
Personalization
).
Either select an existing
Google Analytics
account
or create a new account. If you create a new account, select your
Analytics
reporting location
,
          then accept the data sharing settings and
Google Analytics
terms
          for your project.
You can always set up
Google Analytics
later
          in the
Integrations
tab
of your
settings
Project settings
.
Click
Add Firebase
.
Firebase
adds
        Firebase to your existing project
.
      When the process completes, you'll be taken to the overview page for your
      Firebase project in the
Firebase
console.
Set up your environment and the Firebase CLI
Node.js
You'll need a
Node.js
environment to write functions,
and you'll need the
Firebase
CLI to deploy functions to
the
Cloud Functions
runtime. For installing Node.js and
npm
,
Node Version Manager
is recommended.
Important:
Cloud Functions
and the
Firebase
CLI fully support Node.js
 versions 20 and 22. Version 18 was deprecated in early 2025. See
Set runtime options
for
important information regarding ongoing support for these versions of Node.js.
Once you have Node.js and npm installed,
install the
Firebase
CLI
via your preferred method. To install the CLI via npm, use:
npm install -g firebase-tools
This installs the globally available firebase command. If
the command fails, you may need to
change npm permissions
.
To update to the latest version of
firebase-tools
, rerun the same command.
In many cases, new features and bug fixes are
available only with the latest version of the Firebase CLI and the
firebase-functions
SDK. It's a good practice to frequently
update both the Firebase CLI and the SDK with these commands
inside the
functions
folder of your Firebase project:
npm install firebase-functions@latest firebase-admin@latest --save
npm install -g firebase-tools
Python
You'll need a
Python
environment
to write functions,
and you'll need the
Firebase
CLI to deploy functions to
the
Cloud Functions
runtime. We recommend using
venv
to
isolate dependencies. Python versions 3.10 through 3.13 are supported, 
with 3.13 being the default runtime.
Once you have Python installed,
install the
Firebase
CLI
via your preferred method.
In many cases, new features and bug fixes are
available only with the latest version of the Firebase CLI and the
firebase-functions
SDK. It's a good practice to frequently
update both the Firebase CLI and the SDK
inside the
functions
folder of your Firebase project.
Initialize your project
When you initialize
Firebase
SDK for
Cloud Functions
, you create an empty project
containing dependencies and some minimal sample code. If you are
using Node.js, you can choose either
TypeScript or JavaScript for composing functions. For the purposes of this
tutorial, you'll also need to initialize
Cloud Firestore
.
To initialize your project:
Run
firebase login
to log in via the browser and authenticate the
Firebase
CLI.
Go to your Firebase project directory.
Run
firebase init firestore
. For this tutorial, you can accept the default
values when prompted for Firestore rules and index files. If you haven't used
Cloud Firestore
in this project yet, you'll also
need to select a starting mode and location for Firestore as described in
Get started with
Cloud Firestore
.
Run
firebase init functions
. The CLI prompts you to choose an existing
codebase or initialize and name a new one. When you're just getting started,
a single codebase in the default location is adequate;
later, as your implementation expands, you might
want to
organize functions in codebases
.
The CLI gives you these options for language support:
JavaScript
TypeScript
Python
For this tutorial, select
JavaScript
or
Python
. For authoring in
TypeScript, see
Write Functions with TypeScript
.
The CLI gives you an option to install dependencies. This is safe
to decline if you want to manage dependencies in another way.
After these commands complete successfully, your project structure looks like
this:
Node.js
myproject
+- .firebaserc    # Hidden file that helps you quickly switch between
|                 # projects with `firebase use`
|
+- firebase.json  # Describes properties for your project
|
+- functions/     # Directory containing all your functions code
      |
      +- .eslintrc.json  # Optional file containing rules for JavaScript linting.
      |
      +- package.json  # npm package file describing your
Cloud Functions
code
      |
      +- index.js      # Main source file for your
Cloud Functions
code
      |
      +- node_modules/ # Directory where your dependencies (declared in
                        # package.json) are installed
For Node.js, the
package.json
file created during initialization contains an important
key:
"engines": {"node": "18"}
. This specifies your Node.js version for
writing and deploying functions. You can
select other supported versions
.
Python
myproject
+- .firebaserc    # Hidden file that helps you quickly switch between
|                 # projects with `firebase use`
|
+- firebase.json  # Describes properties for your project
|
+- functions/     # Directory containing all your functions code
      |
      +- main.py      # Main source file for your
Cloud Functions
code
      |
      +- requirements.txt  #  List of the project's modules and packages 
      |
      +- venv/ # Directory where your dependencies are installed
Import the required modules and initialize an app
After you have completed the setup tasks, you can
open the source directory and start adding code as described in the
following sections. For this sample, your project must import the
Cloud Functions
and Admin SDK modules. Add lines
like the following to your source file:
Node.js
// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
const
{
logger
}
=
require
(
"firebase-functions"
);
const
{
onRequest
}
=
require
(
"firebase-functions/https"
);
const
{
onDocumentCreated
}
=
require
(
"firebase-functions/firestore"
);
// The Firebase Admin SDK to access Firestore.
const
{
initializeApp
}
=
require
(
"firebase-admin/app"
);
const
{
getFirestore
}
=
require
(
"firebase-admin/firestore"
);
initializeApp
();
index
.
js
Python
# The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
from
firebase_functions
import
firestore_fn
,
https_fn
# The Firebase Admin SDK to access Cloud Firestore.
from
firebase_admin
import
initialize_app
,
firestore
import
google.cloud.firestore
app
=
initialize_app
()
main
.
py
These lines load the required modules and
initialize an
admin
app instance from which
Cloud Firestore
changes can be made.
Wherever
Admin SDK
support is available, as it is
for
FCM
,
Authentication
, and
Firebase Realtime Database
, it provides a
powerful way to integrate Firebase using
Cloud Functions
.
The
Firebase
CLI automatically
installs the Firebase Admin SDK and
Firebase
SDK for
Cloud Functions
modules when you initialize
your project.  For more information about adding 3rd party libraries
to your project, see
Handle Dependencies
.
Add the "add message" function
For the "add message" function, add these lines to your source file:
Node.js
// Take the text parameter passed to this HTTP endpoint and insert it into
// Firestore under the path /messages/:documentId/original
exports
.
addmessage
=
onRequest
(
async
(
req
,
res
)
=
>
{
// Grab the text parameter.
const
original
=
req
.
query
.
text
;
// Push the new message into Firestore using the Firebase Admin SDK.
const
writeResult
=
await
getFirestore
()
.
collection
(
"messages"
)
.
add
({
original
:
original
});
// Send back a message that we've successfully written the message
res
.
json
({
result
:
`Message with ID:
${
writeResult
.
id
}
added.`
});
});
index
.
js
Python
@https_fn
.
on_request
()
def
addmessage
(
req
:
https_fn
.
Request
)
-
>
https_fn
.
Response
:
"""Take the text parameter passed to this HTTP endpoint and insert it into
a new document in the messages collection."""
# Grab the text parameter.
original
=
req
.
args
.
get
(
"text"
)
if
original
is
None
:
return
https_fn
.
Response
(
"No text parameter provided"
,
status
=
400
)
firestore_client
:
google
.
cloud
.
firestore
.
Client
=
firestore
.
client
()
# Push the new message into Cloud Firestore using the Firebase Admin SDK.
_
,
doc_ref
=
firestore_client
.
collection
(
"messages"
)
.
add
({
"original"
:
original
})
# Send back a message that we've successfully written the message
return
https_fn
.
Response
(
f
"Message with ID
{
doc_ref
.
id
}
added."
)
main
.
py
The "add message" function is an HTTP endpoint. Any request to the endpoint
results in request and response objects passed to the
the request handler for your platform (
onRequest()
or
on_request
).
HTTP functions are synchronous (similar to
callable functions
), so you should send a response
as quickly as possible and defer work using
Cloud Firestore
. The "add message"
HTTP function passes a text value to the HTTP endpoint and inserts it into the
database under the path
/messages/:documentId/original
.
Add the "make uppercase" function
For the "make uppercase" function, add these lines to your source file:
Node.js
// Listens for new messages added to /messages/:documentId/original
// and saves an uppercased version of the message
// to /messages/:documentId/uppercase
exports
.
makeuppercase
=
onDocumentCreated
(
"/messages/{documentId}"
,
(
event
)
=
>
{
// Grab the current value of what was written to Firestore.
const
original
=
event
.
data
.
data
().
original
;
// Access the parameter `{documentId}` with `event.params`
logger
.
log
(
"Uppercasing"
,
event
.
params
.
documentId
,
original
);
const
uppercase
=
original
.
toUpperCase
();
// You must return a Promise when performing
// asynchronous tasks inside a function
// such as writing to Firestore.
// Setting an 'uppercase' field in Firestore document returns a Promise.
return
event
.
data
.
ref
.
set
({
uppercase
},
{
merge
:
true
});
});
index
.
js
Python
@firestore_fn
.
on_document_created
(
document
=
"messages/
{pushId}
"
)
def
makeuppercase
(
event
:
firestore_fn
.
Event
[
firestore_fn
.
DocumentSnapshot
|
None
])
-
>
None
:
"""Listens for new documents to be added to /messages. If the document has
an "original" field, creates an "uppercase" field containg the contents of
"original" in upper case."""
# Get the value of "original" if it exists.
if
event
.
data
is
None
:
return
try
:
original
=
event
.
data
.
get
(
"original"
)
except
KeyError
:
# No "original" field, so do nothing.
return
# Set the "uppercase" field.
print
(
f
"Uppercasing
{
event
.
params
[
'pushId'
]
}
:
{
original
}
"
)
upper
=
original
.
upper
()
event
.
data
.
reference
.
update
({
"uppercase"
:
upper
})
main
.
py
The "make uppercase" function executes when
Cloud Firestore
is written to,
defining the document to listen on. For performance reasons, you
should be as specific as possible.
Braces—for example,
{documentId}
—surround "parameters," wildcards
that expose their matched data in the callback.
Cloud Firestore
triggers the
callback whenever new messages are added.
Caution:
Be careful to avoid any situation in which the function's
result actually retriggers the function, creating an infinite loop —
for example, a function
triggered by writes to a specific
Cloud Firestore
document that terminates by writing
to that same path. Also make sure to write functions in an
idempotent
way, so
that they produce the same result if they run multiple times for a single event.
In Node.js, event-driven functions such as
Cloud Firestore
events are
asynchronous. The callback function should return either a
null
, an Object,
or a
Promise
.
If you do not return anything, the function times out, signaling an error, and
is retried. See
Sync, Async, and Promises
.
Emulate execution of your functions
The
Firebase Local Emulator Suite
allows you to build and test apps on your local machine instead of deploying to
a Firebase project. Local testing during development is strongly recommended,
in part because it lowers the risk from coding errors that could potentially
incur cost in a production environment (for example, an infinite loop).
To emulate your functions:
Run
firebase emulators:start
and check the output for the URL
  of the
Emulator Suite UI
. It defaults to
localhost:4000
, but may be hosted on a different
  port on your machine. Enter that URL in your browser to open the
Emulator Suite UI
.
Check the output of the
firebase emulators:start
command for the URL
of the HTTP function. It will look similar to
http://localhost:5001/MY_PROJECT/us-central1/addMessage
, except that:
MY_PROJECT
will be replaced with your project ID.
The port may be different on your local machine.
Add the query string
?text=uppercaseme
to the end of the function's URL.
This should look something like:
http://localhost:5001/MY_PROJECT/us-central1/addMessage?text=uppercaseme
.
Optionally, you can change the message "uppercaseme" to a custom
     message.
Create a new message by opening the URL in a new tab in your browser.
View the effects of the functions in the
Emulator Suite UI
:
In the
Logs
tab, you should see new logs indicating that 
your HTTP functions ran successfully:
i functions: Beginning execution of "addMessage"
i functions: Beginning execution of "makeUppercase"
In the
Firestore
tab, you should see a document containing your original
message as well as the uppercased version of your message (if it was
originally "uppercaseme", you'll see "UPPERCASEME").
Deploy functions to a production environment
Once your functions are working as desired in the emulator, you can proceed to
deploying, testing, and running them in the production environment. Keep in mind
that to deploy in production, your project
must be on the
Blaze pricing plan
. See
Cloud Functions
pricing
.
To complete the tutorial, deploy your functions and then execute
them.
Run this command to deploy your functions:
firebase deploy --only functions
After you run this command, the
Firebase
CLI outputs the URL for any
 HTTP function
 endpoints. In your terminal, you should see a line like the following:
Function URL (addMessage): https://us-central1-MY_PROJECT.cloudfunctions.net/addMessage
The URL contains your project ID as well as a region for the HTTP
 function. Though you don't need to worry about it now, some production HTTP
 functions should specify a
location
to
 minimize network latency.
If you encounter access errors such as "Unable to authorize access to
project," try checking your
project aliasing
.
Using the URL  output by the CLI, add a text query parameter,
and open it in a browser:
https://us-central1-MY_PROJECT.cloudfunctions.net/addMessage?text=uppercasemetoo
The function executes and redirects the browser to the
Firebase
console at the database location
 where the text string is stored. This
 write event triggers the "make uppercase" function, which writes an uppercase
 version of the string.
After deploying and executing functions, you can
view logs in the
Google Cloud
console
.
If you need to
delete functions
in development or production, use the
Firebase
CLI.
In production, you may want to optimize function performance and control
costs by setting minimum and maximum numbers of instances to run. See
Control scaling behavior
for more information on these runtime options.
Note:
Deployment of functions from
Firebase
CLI is subject to rate limits.
See
Quota limits for
Firebase
CLI deployment
.
Next steps
In this documentation, you can learn more about how to
manage functions
for
Cloud Functions
as well as how to
to handle all event types supported by
Cloud Functions
.
To learn more about
Cloud Functions
, you
could also do the following:
Read about
use cases for
Cloud Functions
.
Try the
Cloud Functions
codelab
.
Review and run
code samples on GitHub
Send feedback
Except as otherwise noted, the content of this page is licensed under the
Creative Commons Attribution 4.0 License
, and code samples are licensed under the
Apache 2.0 License
. For details, see the
Google Developers Site Policies
. Java is a registered trademark of Oracle and/or its affiliates.
Last updated 2026-10-28 UTC.
Need to tell us more?
[[["Easy to understand","easyToUnderstand","thumb-up"],["Solved my problem","solvedMyProblem","thumb-up"],["Other","otherUp","thumb-up"]],[["Missing the information I need","missingTheInformationINeed","thumb-down"],["Too complicated / too many steps","tooComplicatedTooManySteps","thumb-down"],["Out of date","outOfDate","thumb-down"],["Samples / code issue","samplesCodeIssue","thumb-down"],["Other","otherDown","thumb-down"]],["Last updated 2026-10-28 UTC."],[],[]]
