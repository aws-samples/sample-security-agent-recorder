# Requirements Document

## Introduction

The Domain Recorder Extension is a cross-browser WebExtension (Firefox and Chrome) that helps users prepare for an AWS Security Agent pentest configuration. When a user begins setting up a pentest, they need to know every external domain their web application contacts so those domains can be added to the AWS Security Agent's accessible domains list. This extension lets the user start a recording session, interact with their target web application normally (including logging in), and have the extension passively collect every unique domain contacted by any tab during the session. The collected domains are persisted in extension storage and viewable on a dedicated results page that the user can open in a new tab to copy values into the AWS Security Agent console. The extension does not communicate with the AWS Security Agent service in any way.

## Glossary

- **Extension**: The Domain Recorder Extension, the cross-browser WebExtension defined by this specification.
- **Background_Service**: The extension's background script (service worker in Chrome, background script in Firefox) that owns recording state and observes network activity.
- **Popup_UI**: The toolbar popup surface shown when the user clicks the extension's toolbar icon, used to start and stop recording and view current status.
- **Results_Page**: A full-page HTML view, opened in a new browser tab, that lists the unique domains collected during the most recent recording session and supports copy-to-clipboard.
- **Recording_Session**: A bounded period that starts when the user activates recording and ends when the user stops recording, during which observed domains are collected.
- **Observed_Request**: Any HTTP or HTTPS network request initiated by a browser tab and visible to the WebExtensions `webRequest` API while a Recording_Session is active.
- **Domain**: The fully qualified hostname (registered name plus any subdomains, lowercased, without port or path) extracted from the URL of an Observed_Request.
- **Domain_List**: The deduplicated, sorted collection of Domains captured during the current or most recent Recording_Session.
- **Storage**: The browser-provided `storage.local` area used by the Extension to persist recording state and the Domain_List across browser tabs and browser restarts.
- **Recording_State**: An enumerated state of the Extension with values `idle`, `recording`, and `stopped`.

## Requirements

### Requirement 1: Cross-Browser Compatibility

**User Story:** As a security engineer, I want the extension to run on both Firefox and Chrome from a single codebase, so that I can use it regardless of which browser my web application is best tested in.

#### Acceptance Criteria

1. THE Extension SHALL use only WebExtensions APIs that are documented as supported in both Firefox version 115 or later and Chrome version 120 or later.
2. WHEN the Extension is loaded in Firefox version 115 or later or Chrome version 120 or later, THE Extension SHALL parse its Manifest V3 manifest without errors and register all declared background workers, content scripts, and permissions within 5 seconds.
3. WHERE a browser-specific API surface is required, THE Extension SHALL access it through a compatibility shim that returns the native API implementation of the active browser at runtime without requiring code branches in calling modules.
4. IF an API call is unsupported on the active browser, THEN THE Extension SHALL log a diagnostic message to the extension console that identifies the unsupported API name and the active browser name and version.
5. IF an API call is unsupported on the active browser, THEN THE Extension SHALL continue executing all remaining unaffected features without terminating the background worker or any content script.

### Requirement 2: Start a Recording Session

**User Story:** As a security engineer preparing a pentest, I want to start a recording session from the extension toolbar, so that I can begin capturing domains while I use my web application.

#### Acceptance Criteria

1. WHEN the user clicks the start control in the Popup_UI and the Recording_State is `idle` or `stopped`, THE Background_Service SHALL transition the Recording_State to `recording` within 1 second.
2. WHEN the user clicks the start control in the Popup_UI and the Recording_State is already `recording`, THE Background_Service SHALL leave the Recording_State unchanged and SHALL NOT modify the Domain_List.
3. WHEN the Recording_State transitions to `recording`, THE Background_Service SHALL preserve the existing Domain_List in Storage so that subsequent Recording_Sessions append to it.
4. WHEN the user activates the clear control in the Popup_UI or the Results_Page and confirms the clear action, THE Extension SHALL remove the Domain_List from Storage.
5. WHEN the Recording_State transitions to `recording`, THE Background_Service SHALL register a `webRequest.onBeforeRequest` listener with a URL filter pattern of `http://*/*` and `https://*/*`.
6. IF registration of the `webRequest.onBeforeRequest` listener fails, THEN THE Background_Service SHALL revert the Recording_State to its prior value, persist the reverted state to Storage, and log a diagnostic message to the extension console.
7. WHILE the Recording_State is `recording`, THE Popup_UI SHALL display a visible recording indicator and a stop control, and SHALL hide the start control.
8. WHILE the Recording_State is `idle` or `stopped`, THE Popup_UI SHALL hide the stop control and display the start control.
9. WHILE the Recording_State is `recording`, THE Extension SHALL update the toolbar icon or badge to a state visually distinct from the idle appearance.

### Requirement 3: Capture Unique Domains During Recording

**User Story:** As a security engineer, I want the extension to automatically collect every unique domain my web application contacts while I interact with it, so that I do not have to record domains by hand.

#### Acceptance Criteria

1. WHILE the Recording_State is `recording` and an Observed_Request URL has a scheme of `http` or `https`, THE Background_Service SHALL extract the Domain as the hostname component of the URL, excluding scheme, port, path, query, and fragment.
2. THE Background_Service SHALL normalize each extracted Domain by converting all alphabetic characters to lowercase and removing any single trailing dot before comparison and storage.
3. WHEN a Domain is extracted from an Observed_Request, IF the normalized Domain is not already present in the Domain_List, THEN THE Background_Service SHALL append the normalized Domain to the Domain_List.
4. WHEN the Domain_List changes, THE Background_Service SHALL persist the updated Domain_List to Storage within 500ms.
5. IF persisting the Domain_List to Storage fails, THEN THE Background_Service SHALL retain the in-memory Domain_List unchanged and log a diagnostic message to the extension console.
6. IF an Observed_Request URL cannot be parsed by the WHATWG URL parser or yields an empty hostname, THEN THE Background_Service SHALL discard the Observed_Request without modifying the Domain_List.
7. IF an Observed_Request URL has a scheme other than `http` or `https`, THEN THE Background_Service SHALL discard the Observed_Request without modifying the Domain_List.
8. WHILE the Recording_State is not `recording`, THE Background_Service SHALL NOT add new entries to the Domain_List.

### Requirement 4: Stop a Recording Session

**User Story:** As a security engineer, I want to stop the recording when I am done interacting with my application, so that the captured domain list is finalized and no further requests are recorded.

#### Acceptance Criteria

1. WHEN the user clicks the stop control in the Popup_UI and the Recording_State is `recording`, THE Background_Service SHALL transition the Recording_State to `stopped` within 1 second.
2. IF the user clicks the stop control while the Recording_State is `idle` or `stopped`, THEN THE Background_Service SHALL leave the Recording_State unchanged and SHALL NOT modify the Domain_List.
3. WHEN the Recording_State transitions to `stopped`, THE Background_Service SHALL unregister the `webRequest.onBeforeRequest` listener registered for the session before any subsequent network request is processed.
4. WHEN the Recording_State transitions to `stopped`, THE Background_Service SHALL persist the Recording_State value `stopped` to Storage.
5. WHEN the Recording_State transitions to `stopped`, THE Background_Service SHALL persist the Domain_List, containing only Domains captured while the Recording_State was `recording`, to Storage.
6. IF persisting the Recording_State or Domain_List to Storage during a stop transition fails, THEN THE Background_Service SHALL log a diagnostic message to the extension console identifying which write failed and SHALL retain the in-memory Recording_State and Domain_List unchanged.
7. WHILE the Recording_State is `stopped`, THE Popup_UI SHALL display a labeled button that opens the Results_Page in a new browser tab.
8. WHILE the Recording_State is `stopped`, THE Extension SHALL display the toolbar icon or badge with no active-recording indicator and an empty badge, matching the `idle` state visuals.

### Requirement 5: Persist Recording State and Domain List

**User Story:** As a security engineer, I want the captured domains to remain available after I close the popup or restart the browser, so that I can later open the AWS Security Agent console in a new tab and copy them in.

#### Acceptance Criteria

1. THE Extension SHALL store the Recording_State and Domain_List in Storage using the `storage.local` area.
2. WHEN the Recording_State changes or the Domain_List changes, THE Background_Service SHALL persist the updated value to Storage within 500ms.
3. WHEN the Background_Service starts, THE Background_Service SHALL load the Recording_State and Domain_List from Storage into memory within 2 seconds.
4. IF Storage contains no Recording_State or no Domain_List on Background_Service start, THEN THE Background_Service SHALL initialize the missing value in memory to `idle` for Recording_State or to an empty list for Domain_List, and persist the initialized value to Storage.
5. IF reading Recording_State or Domain_List from Storage fails on Background_Service start, THEN THE Background_Service SHALL initialize the affected value in memory to `idle` for Recording_State or to an empty list for Domain_List, and log a diagnostic message identifying the failed key to the extension console.
6. IF the loaded Recording_State from Storage is `recording` after a browser restart, THEN THE Background_Service SHALL set the in-memory Recording_State to `stopped` and persist `stopped` to Storage.
7. IF the persistence write described in criterion 6 fails, THEN THE Background_Service SHALL retain the in-memory Recording_State as `recording` and log a diagnostic message identifying the failed key to the extension console.
8. WHEN the user reopens the Popup_UI, THE Popup_UI SHALL display the Recording_State and the count of Domains in the Domain_List loaded from Storage within 1 second.
9. IF the Popup_UI cannot read the Recording_State or Domain_List from Storage on open, THEN THE Popup_UI SHALL display an error indication and SHALL display the Recording_State as `idle` and the Domain count as zero.

### Requirement 6: View Captured Domains on the Results Page

**User Story:** As a security engineer, I want to open a results page in a new tab that lists all captured domains, so that I can review them and copy them into the AWS Security Agent console.

#### Acceptance Criteria

1. WHEN the user activates the open-results control in the Popup_UI, THE Extension SHALL open the Results_Page in a new browser tab within 2 seconds.
2. WHEN the Results_Page loads, THE Results_Page SHALL retrieve the Domain_List from Storage and render the displayed list within 2 seconds of load completion.
3. THE Results_Page SHALL display the Domain_List sorted in case-insensitive ascending alphabetical order regardless of whether the list is currently shown to the user.
4. THE Results_Page SHALL display the count of unique Domains in the Domain_List as a non-negative integer, displaying zero when the Domain_List contains no entries.
5. WHEN the user activates the copy-all control on the Results_Page and the Domain_List contains at least one Domain, THE Results_Page SHALL write the Domain_List to the system clipboard as newline-separated text in the same case-insensitive ascending alphabetical order used for display.
6. WHEN the user activates the clear control on the Results_Page and confirms the clear action, THE Results_Page SHALL remove the Domain_List from Storage and update the displayed list to empty with a count of zero within 2 seconds.
7. WHILE the Recording_State is `recording` and the Results_Page is open, THE Results_Page SHALL refresh the displayed Domain_List and the unique-Domain count within 2 seconds of any change to the Domain_List in Storage.
8. IF retrieving the Domain_List from Storage fails, THEN THE Results_Page SHALL display an error indication that the list could not be loaded and SHALL display an empty list with a count of zero.
9. IF the user activates the copy-all control while the Domain_List contains zero Domains, THEN THE Results_Page SHALL display an indication that no Domains are available to copy and SHALL NOT write to the system clipboard.
10. IF writing the Domain_List to the system clipboard fails, THEN THE Results_Page SHALL display an error indication that the copy operation did not complete and SHALL preserve the Domain_List in Storage unchanged.

### Requirement 7: Domain Extraction Correctness

**User Story:** As a security engineer, I want the captured domains to accurately reflect what my application contacts, so that the list I paste into the AWS Security Agent console is complete and free of duplicates.

#### Acceptance Criteria

1. WHEN the Background_Service receives an Observed_Request with an HTTP or HTTPS URL, THE Background_Service SHALL parse the URL with the WHATWG URL parser, read the host component, and convert all ASCII alphabetic characters in the host to lowercase before further processing.
2. THE Background_Service SHALL exclude any port number from the extracted Domain.
3. THE Background_Service SHALL exclude any path, query string, or fragment from the extracted Domain.
4. IF a request URL contains an internationalized domain name, THEN THE Background_Service SHALL store the Domain in its punycode (ASCII) form as produced by the WHATWG URL parser.
5. THE Background_Service SHALL produce a byte-for-byte identical Domain string for any two Observed_Requests whose URLs are equal as strings.
6. IF a request URL has a scheme other than HTTP or HTTPS, THEN THE Background_Service SHALL discard the request without modifying the Domain_List.
7. IF the WHATWG URL parser fails to parse a request URL, or if the parsed host component is empty, THEN THE Background_Service SHALL discard the request without modifying the Domain_List.
8. THE Background_Service SHALL ensure the Domain_List contains no two entries whose Domain strings are byte-for-byte identical.

### Requirement 8: Domain List Invariants

**User Story:** As a security engineer, I want the captured domain list to be free of duplicates and predictable in order, so that I can review it efficiently.

#### Acceptance Criteria

1. THE Domain_List SHALL contain no two Domain values that are equal under the comparison rule defined as: trim leading and trailing ASCII whitespace from both values, then compare case-insensitively using ASCII case folding.
2. THE Domain_List SHALL contain only Domain strings whose length is between 1 and 253 characters inclusive and that contain no leading or trailing ASCII whitespace characters.
3. WHEN the Domain_List is read from Storage and contains up to 10,000 entries, THE Extension SHALL present it in case-insensitive ascending alphabetical order within 500ms of the read completing.
4. WHEN a Domain is added to the Domain_List and the Domain is not already present under the comparison rule in criterion 1, THE size of the Domain_List SHALL increase by exactly one.
5. WHEN a Domain is added to the Domain_List and the Domain is already present under the comparison rule in criterion 1, THE size of the Domain_List SHALL remain unchanged.
6. IF an attempt is made to add a Domain that would cause the Domain_List size to exceed 10,000 entries, THEN THE Extension SHALL reject the addition, leave the Domain_List size unchanged, and log a diagnostic message to the extension console.

### Requirement 9: User Guidance Prompt

**User Story:** As a first-time user of the extension, I want to be prompted to interact with my application after I start recording, so that I know what to do to ensure all domains are captured.

#### Acceptance Criteria

1. WHEN the Recording_State transitions to `recording`, THE Popup_UI SHALL display, within 1 second, guidance text instructing the user to (a) navigate to the target web application, (b) sign in to the application, and (c) interact with the application to trigger loading of all expected resources.
2. WHILE the Recording_State is `recording` and the Popup_UI is open, THE Popup_UI SHALL display the current count of unique Domains captured so far, initialized to 0 at the start of the Recording_Session, and updated within 2 seconds of each new unique Domain being added to the Domain_List.
3. WHEN the user opens the Popup_UI while the Recording_State is `recording`, THE Popup_UI SHALL display the guidance text from criterion 1 and the current count of unique Domains from criterion 2.

### Requirement 10: Permissions and Privacy

**User Story:** As a security engineer running this on my work machine, I want the extension to request only the permissions it needs and to keep all captured data local, so that I am comfortable installing it.

#### Acceptance Criteria

1. THE Extension SHALL declare in its manifest only the following permissions: `webRequest`, `storage`, and `tabs`, plus host permissions covering HTTP and HTTPS URLs, and SHALL NOT declare any additional API or host permissions.
2. THE Extension SHALL store the Domain_List only in the browser's local extension storage area, and SHALL NOT use sync, session, or managed storage areas, nor any storage location outside the browser's extension storage.
3. THE Extension SHALL NOT initiate any outbound network request from its background, content, popup, or options scripts that transmits the Domain_List, any Observed_Request data, or any analytics or telemetry to any network endpoint.
4. THE Extension SHALL NOT include or load third-party analytics, telemetry, or tracking scripts at runtime.
5. IF the user uninstalls the Extension through the browser's extension management interface, THEN the browser SHALL remove all data the Extension stored in the local extension storage area, leaving no Extension-written data behind in that storage area.
