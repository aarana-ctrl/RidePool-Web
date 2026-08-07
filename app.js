// app.js – RidePool Web App
//
// ── SETUP ────────────────────────────────────────────────────────────────
// 1. Go to Firebase Console → Project Settings → Your Apps → Web App
//    (add one if you haven't yet) and copy the firebaseConfig object below.
// 2. Enable Authentication → Google and Email/Password providers.
// 3. To deploy: run `firebase init hosting` pointing to the web/ folder,
//    then `firebase deploy`.
// ─────────────────────────────────────────────────────────────────────────

// ── HOW TO GET YOUR CONFIG ────────────────────────────────────────────────
// Firebase Console → Project Settings (gear icon) → scroll down to
// "Your apps" → click your Web App (or "Add app" → Web if none exists)
// → copy the firebaseConfig values into the object below.
// ─────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAR3zqKvaUiFfKkn8FoXsVnUa901V-hdz8",
  authDomain:        "project-ridepool.firebaseapp.com",
  projectId:         "project-ridepool",
  storageBucket:     "project-ridepool.firebasestorage.app",
  messagingSenderId: "42076561004",
  appId:             "1:42076561004:web:004bf8aae07503f56cc249",
  measurementId:     "G-NG8F4DD9ND",
};

// Guard — shows a friendly setup message instead of a cryptic API-key error
if (!FIREBASE_CONFIG.apiKey) {
  document.body.innerHTML = `
    <div style="font-family:system-ui;max-width:480px;margin:80px auto;padding:32px;
                background:#fff;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="font-size:36px;margin-bottom:16px">🔧</div>
      <h2 style="margin-bottom:8px">Firebase setup needed</h2>
      <p style="color:#6B6B7A;font-size:14px;line-height:1.6">
        Open <code>app.js</code> and fill in your Firebase project credentials.<br><br>
        <strong>Where to find them:</strong><br>
        Firebase Console → Project Settings → Your Apps → Web App → firebaseConfig
      </p>
    </div>`;
  throw new Error('Firebase config missing — fill in app.js');
}

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  user:           null,   // Firebase Auth user
  profile:        null,   // Firestore /users/{uid}
  events:         [],
  offers:         [],
  requests:       [],
  currentView:    'home',
  selectedEvent:  null,
  selectedOffer:  null,
  selectedRole:   'student',
  selectedObRole: 'student',
  listeners:      [],
};

// ── School domain verification (mirrors SchoolVerifier.swift) ─────────────

const KNOWN_DOMAINS = new Set([
  'lwsd.org','bsd405.org','seattleschools.org','rentonschools.us','nsd.org',
  'shorelineschools.org','fwps.org','everettsd.org','lausd.net','sfusd.edu',
  'sandi.net','ousd.org','scusd.edu','schools.nyc.gov','houstonisd.org',
  'austinisd.org','dallasisd.org','cps.edu','browardschools.com',
  'dadeschools.net','ocps.net','duvalschools.org','philasd.org',
  'fcps.edu','mcpsmd.org','pgcps.org','bostonpublicschools.org',
]);

function isSchoolEmail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (domain.endsWith('.edu'))   return true;
  if (domain.includes('.k12.'))  return true;
  if (domain.endsWith('.k12.us')) return true;
  if (KNOWN_DOMAINS.has(domain)) return true;
  const labels = domain.split('.');
  const schoolLabels = ['isd','usd','cusd','pusd','musd','schools','fcps','dcps','mcps'];
  if (labels.slice(0,-1).some(l => schoolLabels.includes(l))) return true;
  return false;
}

// ── Auth state observer ───────────────────────────────────────────────────

auth.onAuthStateChanged(async (user) => {
  if (user) {
    state.user = user;
    const doc = await db.collection('users').document(user.uid).get().catch(() => null)
              || await db.collection('users').doc(user.uid).get().catch(() => null);
    if (doc && doc.exists) {
      state.profile = { uid: user.uid, ...doc.data() };
      if (!state.profile.school || !state.profile.year) {
        showScreen('onboarding');
      } else {
        enterApp();
      }
    } else {
      // First-time Google user — partial profile
      state.profile = { uid: user.uid, name: user.displayName || '', email: user.email || '',
                        school: '', year: '', role: 'student', credits: 0 };
      showScreen('onboarding');
    }
  } else {
    state.user = null; state.profile = null;
    stopListeners();
    showScreen('auth');
  }
});

// ── Firestore listeners ───────────────────────────────────────────────────

function startListeners() {
  const l1 = db.collection('events').orderBy('date')
    .onSnapshot(snap => { state.events = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderIfActive('home'); updateNotifBadge(); });
  const l2 = db.collection('rideOffers')
    .onSnapshot(snap => { state.offers = snap.docs.map(d => ({ id: d.id, ...d.data() })); if (state.currentView === 'event') renderEventDetail(); });
  const l3 = db.collection('rideRequests')
    .onSnapshot(snap => { state.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })); updateNotifBadge(); renderIfActive('notifications'); renderIfActive('rides'); });
  state.listeners = [l1, l2, l3];
}

function stopListeners() {
  state.listeners.forEach(u => u()); state.listeners = [];
}

function renderIfActive(view) {
  if (state.currentView === view) navigate(view);
}

// ── Auth handlers ─────────────────────────────────────────────────────────

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'signin') || (i === 1 && tab === 'signup'));
  });
  document.getElementById('form-signin').classList.toggle('hidden', tab !== 'signin');
  document.getElementById('form-signup').classList.toggle('hidden', tab !== 'signup');
  clearAuthError();
}

async function handleSignIn(e) {
  e.preventDefault();
  const email = document.getElementById('si-email').value.trim();
  const pass  = document.getElementById('si-password').value;
  if (!isSchoolEmail(email)) return showAuthError("Sorry, this platform is for students and staff members only.");
  setAuthLoading(true);
  try { await auth.signInWithEmailAndPassword(email, pass); }
  catch(err) { showAuthError(friendlyError(err)); }
  finally { setAuthLoading(false); }
}

async function handleSignUp(e) {
  e.preventDefault();
  const name   = document.getElementById('su-name').value.trim();
  const email  = document.getElementById('su-email').value.trim();
  const pass   = document.getElementById('su-password').value;
  const school = document.getElementById('su-school').value.trim();
  const year   = document.getElementById('su-year').value;
  const role   = state.selectedRole;
  if (!isSchoolEmail(email)) return showAuthError("Sorry, this platform is for students and staff members only.");
  setAuthLoading(true);
  try {
    const res = await auth.createUserWithEmailAndPassword(email, pass);
    await saveProfile({ uid: res.user.uid, name, email, school, year, role, credits: 0 });
  } catch(err) { showAuthError(friendlyError(err)); }
  finally { setAuthLoading(false); }
}

async function handleGoogleSignIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try { await auth.signInWithPopup(provider); }
  catch(err) { showAuthError(friendlyError(err)); }
}

async function handleOnboarding(e) {
  e.preventDefault();
  const school = document.getElementById('ob-school').value.trim();
  const year   = document.getElementById('ob-year').value;
  const role   = state.selectedObRole;
  if (!school || !year) return;
  state.profile = { ...state.profile, school, year, role };
  await saveProfile(state.profile);
  enterApp();
}

async function saveProfile(profile) {
  await db.collection('users').doc(profile.uid).set(profile);
  state.profile = profile;
}

function selectRole(btn) {
  document.querySelectorAll('#role-picker .role-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.selectedRole = btn.dataset.role;
}
function selectObRole(btn) {
  document.querySelectorAll('#ob-role-picker .role-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.selectedObRole = btn.dataset.role;
}

// ── App entry / navigation ────────────────────────────────────────────────

function enterApp() {
  showScreen('app');
  startListeners();
  seedIfEmpty();
  navigate('home');
}

function showScreen(name) {
  ['auth','onboarding','app'].forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    el.classList.toggle('active', s === name);
    el.classList.toggle('hidden', s !== name);
  });
}

function navigate(view, data = {}) {
  Object.assign(state, data, { currentView: view });
  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
  const el = document.getElementById(`view-${view}`);
  el.classList.add('active'); el.classList.remove('hidden');

  // Update sidebar + bottom nav
  document.querySelectorAll('.nav-item, .bnav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  switch(view) {
    case 'home':          renderHome(); break;
    case 'event':         renderEventDetail(); break;
    case 'create':        renderCreateEvent(); break;
    case 'rides':         renderRides(); break;
    case 'notifications': renderNotifications(); break;
    case 'shop':          renderShop(); break;
    case 'profile':       renderProfile(); break;
  }
}

// ── Render: Home ──────────────────────────────────────────────────────────

function renderHome() {
  const el = document.getElementById('view-home');
  const canPost = canPostEvents();

  el.innerHTML = `
    <div class="header-row">
      <div>
        <h2>Upcoming Events</h2>
        <p style="color:var(--text-secondary);font-size:14px;margin-top:4px">
          Hi ${state.profile?.name?.split(' ')[0] || ''} 👋  Find your next ride.
        </p>
      </div>
      ${canPost ? `<button class="btn-primary" style="width:auto;padding:10px 18px;font-size:14px" onclick="navigate('create')">+ Post Event</button>` : ''}
    </div>
    ${state.events.length === 0
      ? `<div class="loading">Loading events…</div>`
      : `<div class="event-grid">${state.events.map(eventCard).join('')}</div>`
    }
  `;
}

function eventCard(e) {
  const icon = themeIcon(e.colorTheme);
  const bgClass = `bg-${e.colorTheme}`;
  return `
    <div class="event-card" onclick="navigate('event', { selectedEvent: ${JSON.stringify(e).replace(/"/g,'&quot;')} })">
      <div class="event-card-icon ${bgClass}">${icon}</div>
      <div class="event-card-body">
        <div class="event-card-name">${e.name}</div>
        <div class="event-card-meta">${fmtDate(e.date)} · ${e.location}</div>
        <div class="tag-row">${(e.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
      </div>
    </div>
  `;
}

// ── Render: Event Detail ──────────────────────────────────────────────────

function renderEventDetail() {
  const e = state.selectedEvent;
  if (!e) return navigate('home');

  const offers = state.offers.filter(o => o.eventId === e.id && o.seatsAvailable > 0
    && o.driverUid !== state.profile?.uid);
  const scored = rankOffers(offers);
  const myOffer = state.offers.find(o => o.eventId === e.id && o.driverUid === state.profile?.uid);
  const bgClass = `bg-${e.colorTheme}`;
  const icon = themeIcon(e.colorTheme);

  document.getElementById('view-event').innerHTML = `
    <button class="back-btn" onclick="navigate('home')">← Back to Events</button>

    <div class="event-hero ${bgClass}">
      <div class="event-hero-icon">${icon}</div>
      <div>
        <div class="event-hero-name">${e.name}</div>
        <div class="event-hero-meta">${fmtDate(e.date)} · ${e.location}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <div class="section-title">About</div>
      <p style="font-size:14px;color:var(--text-secondary);line-height:1.6">${e.description}</p>
      <div class="tag-row" style="margin-top:12px">${(e.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
    </div>

    <!-- My offer -->
    ${myOffer ? `
    <div class="section-title">Your Offer</div>
    <div class="offer-card" style="border:1.5px solid var(--primary)">
      <div class="offer-left">
        <div class="offer-driver">You are driving 🚗</div>
        <div class="offer-notes">${myOffer.notes || 'No notes'}</div>
        <div class="offer-seats">${myOffer.seatsAvailable} / ${myOffer.totalSeats} seats remaining</div>
      </div>
      <button class="btn-secondary" style="width:auto;padding:8px 14px;font-size:12px"
        onclick="removeMyOffer('${myOffer.id}')">Remove</button>
    </div>` : `
    <div class="section-title">Offer a Ride</div>
    <div class="card" style="margin-bottom:24px">
      <div style="display:flex;gap:10px;margin-bottom:10px">
        <select id="seats-select" style="background:var(--background);padding:10px 12px;border-radius:var(--r-md);flex:1">
          <option value="1">1 seat</option><option value="2">2 seats</option>
          <option value="3" selected>3 seats</option><option value="4">4 seats</option>
        </select>
      </div>
      <input id="offer-notes" placeholder="Add a note for riders (optional)"
        style="background:var(--background);padding:10px 12px;border-radius:var(--r-md);width:100%;margin-bottom:10px" />
      <button class="btn-primary" style="font-size:14px" onclick="registerDriver('${e.id}')">Register as Driver</button>
    </div>`}

    <!-- Available rides -->
    <div class="section-title">Available Rides (${offers.length})</div>
    ${scored.length === 0
      ? `<div class="empty-state"><div class="empty-emoji">🚘</div><h3>No rides yet</h3><p>Be the first to offer a ride!</p></div>`
      : scored.map((s, i) => offerCard(s, i === 0)).join('')
    }
  `;
}

function offerCard({ offer, reason }, isBest) {
  const alreadyReq = state.requests.some(r => r.offerId === offer.id && r.fromUserUid === state.profile?.uid);
  return `
    <div class="offer-card">
      <div class="offer-left">
        ${isBest ? `<span class="suggested-badge">✦ Best match</span><br>` : ''}
        <div class="offer-driver">${offer.driverUid === 'sample-1' ? 'Rana Ahmed' : offer.driverUid === 'sample-3' ? 'Sarah Chen' : 'Driver'}</div>
        <div class="offer-notes">${offer.notes || ''}</div>
        <div class="offer-seats">${offer.seatsAvailable} seat${offer.seatsAvailable !== 1 ? 's' : ''} available · ${reason}</div>
      </div>
      <div class="offer-actions">
        <span class="seats-pill">${offer.seatsAvailable}/${offer.totalSeats}</span>
        ${alreadyReq
          ? `<span style="font-size:12px;color:var(--text-tertiary)">Requested</span>`
          : offer.seatsAvailable > 0
          ? `<button class="btn-primary" style="padding:8px 14px;font-size:13px;width:auto" onclick="requestRide('${offer.id}','${offer.eventId}')">Request</button>`
          : `<span style="font-size:12px;color:var(--text-tertiary)">Full</span>`
        }
      </div>
    </div>
  `;
}

// ── Render: Create Event ──────────────────────────────────────────────────

function renderCreateEvent() {
  const el = document.getElementById('view-create');
  if (!canPostEvents()) {
    el.innerHTML = `
      <div class="page-header"><h2>Post an Event</h2></div>
      <div class="empty-state">
        <div class="empty-emoji">🔒</div>
        <h3>Restricted</h3>
        <p>Only Staff and Student Reps can post events.</p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header"><h2>Post an Event</h2></div>
    <form class="create-form" onsubmit="handleCreateEvent(event)">
      <div class="field-group">
        <label>Event Name</label>
        <input type="text" id="ev-name" placeholder="Spring Dance" required />
      </div>
      <div class="field-group">
        <label>Date</label>
        <input type="date" id="ev-date" required />
      </div>
      <div class="field-group">
        <label>Location</label>
        <input type="text" id="ev-location" placeholder="School Gymnasium" required />
      </div>
      <div class="field-group">
        <label>Description</label>
        <textarea id="ev-desc" rows="4" placeholder="What's happening?" required
          style="background:var(--background);padding:13px 14px;border-radius:var(--r-md);resize:vertical;font-size:15px;color:var(--text)"></textarea>
      </div>
      <div class="field-group">
        <label>Tags (comma separated)</label>
        <input type="text" id="ev-tags" placeholder="Dance, Social" />
      </div>
      <div class="field-group">
        <label>Theme</label>
        <select id="ev-theme" style="background:var(--background);padding:13px 14px;border-radius:var(--r-md)">
          <option value="warm">Warm (Terracotta)</option>
          <option value="cool" selected>Cool (Blue)</option>
          <option value="hero">Indigo</option>
          <option value="green">Green</option>
        </select>
      </div>
      <button type="submit" class="btn-primary">Post Event</button>
    </form>
  `;
}

async function handleCreateEvent(e) {
  e.preventDefault();
  const newEvent = {
    name:        document.getElementById('ev-name').value.trim(),
    date:        firebase.firestore.Timestamp.fromDate(new Date(document.getElementById('ev-date').value)),
    location:    document.getElementById('ev-location').value.trim(),
    description: document.getElementById('ev-desc').value.trim(),
    tags:        document.getElementById('ev-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    colorTheme:  document.getElementById('ev-theme').value,
    organizerUid: state.profile?.uid || '',
    isFeatured:  false,
  };
  try {
    await db.collection('events').add(newEvent);
    showToast('Event posted!');
    navigate('home');
  } catch { showToast('Failed to post event.'); }
}

// ── Render: Notifications ─────────────────────────────────────────────────

function renderNotifications() {
  const myOfferIds = state.offers.filter(o => o.driverUid === state.profile?.uid).map(o => o.id);
  const myRequests = state.requests.filter(r => myOfferIds.includes(r.offerId));

  document.getElementById('view-notifications').innerHTML = `
    <div class="page-header"><h2>Notifications</h2></div>
    ${myRequests.length === 0
      ? `<div class="empty-state"><div class="empty-emoji">🔔</div><h3>All quiet</h3><p>Ride requests will show up here.</p></div>`
      : myRequests.map(r => {
          const offer = state.offers.find(o => o.id === r.offerId);
          const event = state.events.find(ev => ev.id === r.eventId);
          const pending = r.status === 'pending';
          return `
          <div class="request-card">
            <div style="font-size:14px;font-weight:600">${r.fromUserUid.startsWith('sample-') ? sampleName(r.fromUserUid) : 'A user'} wants a ride</div>
            <div class="request-meta">${event?.name || 'Event'} · ${r.timestamp ? fmtRelative(r.timestamp) : ''}</div>
            ${pending ? `
            <div class="request-actions">
              <button class="btn-accept" onclick="respond('${r.id}', true)">Accept</button>
              <button class="btn-decline" onclick="respond('${r.id}', false)">Decline</button>
            </div>` : `<span class="status-pill ${r.status}">${capitalize(r.status)}</span>`}
          </div>`;
        }).join('')
    }
  `;
}

// ── Render: My Rides ──────────────────────────────────────────────────────

function renderRides() {
  const myDrives = state.offers.filter(o => o.driverUid === state.profile?.uid);
  const myRequests = state.requests.filter(r => r.fromUserUid === state.profile?.uid);

  document.getElementById('view-rides').innerHTML = `
    <div class="page-header"><h2>My Rides</h2></div>

    <div class="section-title" style="margin-bottom:12px">My Drives</div>
    ${myDrives.length === 0
      ? `<p style="color:var(--text-secondary);font-size:14px;margin-bottom:28px">You haven't offered any rides yet.</p>`
      : myDrives.map(o => {
          const ev = state.events.find(e => e.id === o.eventId);
          return `<div class="ride-row">
            <div class="ride-left">
              <div class="ride-event">${ev?.name || 'Event'}</div>
              <div class="ride-role">${o.seatsAvailable}/${o.totalSeats} seats remaining</div>
            </div>
            <span class="status-pill" style="background:var(--tint);color:var(--primary)">Driver</span>
          </div>`;
        }).join('')
    }

    <div class="section-title" style="margin-top:24px;margin-bottom:12px">My Requests</div>
    ${myRequests.length === 0
      ? `<p style="color:var(--text-secondary);font-size:14px">You haven't requested any rides yet.</p>`
      : myRequests.map(r => {
          const ev = state.events.find(e => e.id === r.eventId);
          return `<div class="ride-row">
            <div class="ride-left">
              <div class="ride-event">${ev?.name || 'Event'}</div>
              <div class="ride-role">Passenger</div>
            </div>
            <span class="status-pill ${r.status}">${capitalize(r.status)}</span>
          </div>`;
        }).join('')
    }
  `;
}

// ── Render: Shop ──────────────────────────────────────────────────────────

const SHOP_ITEMS = [
  { id:1, name:'School Hoodie',  credits:150, emoji:'👕', category:'Apparel' },
  { id:2, name:'Water Bottle',   credits:75,  emoji:'🫙', category:'Accessories' },
  { id:3, name:'Sticker Pack',   credits:30,  emoji:'⭐', category:'Fun' },
  { id:4, name:'$10 Gift Card',  credits:200, emoji:'🎁', category:'Gift Cards' },
  { id:5, name:'Backpack',       credits:300, emoji:'🎒', category:'Accessories' },
  { id:6, name:'Phone Stand',    credits:50,  emoji:'📱', category:'Tech' },
];

function renderShop() {
  const myCredits = state.profile?.credits || 0;
  document.getElementById('view-shop').innerHTML = `
    <div class="header-row" style="margin-bottom:24px">
      <div><h2>Rewards Shop</h2><p style="color:var(--text-secondary);font-size:14px;margin-top:4px">Spend your credits</p></div>
      <div style="text-align:right">
        <div style="font-size:24px;font-weight:700">${myCredits}</div>
        <div style="font-size:12px;color:var(--text-secondary)">credits</div>
      </div>
    </div>
    <div class="shop-grid">
      ${SHOP_ITEMS.map(item => `
        <div class="shop-card">
          <div class="shop-emoji">${item.emoji}</div>
          <div class="shop-name">${item.name}</div>
          <div class="shop-cost">${item.credits} credits</div>
          <button class="shop-btn" onclick="redeemItem(${item.id},${item.credits},'${item.name}')"
            ${myCredits < item.credits ? 'disabled style="opacity:.4;cursor:default"' : ''}>Redeem</button>
        </div>
      `).join('')}
    </div>
  `;
}

async function redeemItem(id, cost, name) {
  const myCredits = state.profile?.credits || 0;
  if (myCredits < cost) return showToast('Not enough credits 😔');
  state.profile.credits -= cost;
  await db.collection('users').doc(state.profile.uid).update({ credits: state.profile.credits });
  showToast(`🎉 ${name} redeemed!`);
  renderShop();
}

// ── Render: Profile ───────────────────────────────────────────────────────

function renderProfile() {
  const p = state.profile || {};
  const initials = (p.name || '').split(' ').map(w => w[0]).slice(0,2).join('');
  const roleLabel = { student:'Student', staff:'Staff / Faculty', studentRep:'Student Rep / Club Organizer' }[p.role] || p.role;

  document.getElementById('view-profile').innerHTML = `
    <div class="page-header"><h2>Profile</h2></div>
    <div class="profile-card">
      <div class="avatar-ring">${initials}</div>
      <div class="profile-name">${p.name || ''}</div>
      <div class="profile-email">${p.email || ''}</div>
      <div class="profile-row"><span>School</span><span>${p.school || '—'}</span></div>
      <div class="profile-row"><span>Year</span><span>${p.year || '—'}</span></div>
      <div class="profile-row"><span>Role</span><span>${roleLabel}</span></div>
      <div class="profile-row"><span>Credits</span><span>${p.credits || 0} ⭐</span></div>
      <div style="margin-top:20px">
        <button class="btn-secondary" onclick="handleSignOut()">Sign Out</button>
      </div>
    </div>
  `;
}

// ── Actions ───────────────────────────────────────────────────────────────

async function registerDriver(eventId) {
  const seats = parseInt(document.getElementById('seats-select').value);
  const notes = document.getElementById('offer-notes').value.trim();
  try {
    await db.collection('rideOffers').add({
      eventId, driverUid: state.profile.uid,
      seatsAvailable: seats, totalSeats: seats, notes,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("You're registered as a driver 🚗");
    renderEventDetail();
  } catch { showToast('Failed to register.'); }
}

async function removeMyOffer(offerId) {
  try {
    await db.collection('rideOffers').doc(offerId).delete();
    showToast('Offer removed.');
    renderEventDetail();
  } catch { showToast('Failed to remove offer.'); }
}

async function requestRide(offerId, eventId) {
  const alreadyReq = state.requests.some(r => r.offerId === offerId && r.fromUserUid === state.profile?.uid);
  if (alreadyReq) return;
  try {
    const offer = state.offers.find(o => o.id === offerId);
    await db.collection('rideRequests').add({
      fromUserUid: state.profile.uid, offerId, eventId,
      status: 'pending', timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (offer && offer.seatsAvailable > 0) {
      await db.collection('rideOffers').doc(offerId).update({ seatsAvailable: offer.seatsAvailable - 1 });
    }
    showToast('Ride request sent ✨');
    renderEventDetail();
  } catch { showToast('Failed to send request.'); }
}

async function respond(requestId, accept) {
  const status = accept ? 'accepted' : 'declined';
  try {
    await db.collection('rideRequests').doc(requestId).update({ status });
    if (accept) {
      const newCredits = (state.profile?.credits || 0) + 10;
      state.profile = { ...state.profile, credits: newCredits };
      await db.collection('users').doc(state.profile.uid).update({ credits: newCredits });
    } else {
      const req = state.requests.find(r => r.id === requestId);
      if (req) {
        const offer = state.offers.find(o => o.id === req.offerId);
        if (offer) await db.collection('rideOffers').doc(offer.id).update({ seatsAvailable: offer.seatsAvailable + 1 });
      }
    }
    showToast(accept ? 'Ride accepted! +10 credits 🎉' : 'Request declined.');
    renderNotifications();
  } catch { showToast('Action failed.'); }
}

async function handleSignOut() {
  stopListeners();
  await auth.signOut();
}

// ── Seed sample data ──────────────────────────────────────────────────────

async function seedIfEmpty() {
  const snap = await db.collection('events').limit(1).get();
  if (!snap.empty) return;

  const batch = db.batch();
  const sampleEvents = [
    { name:'Homecoming 2024', date: firebase.firestore.Timestamp.fromDate(new Date('2024-04-15')),
      description:'The biggest school event of the year!', location:'School Gymnasium',
      organizerUid:'sample-3', tags:['Dance','Social'], colorTheme:'warm', isFeatured:true },
    { name:'ISA × MSA Eid Celebration', date: firebase.firestore.Timestamp.fromDate(new Date('2024-04-10')),
      description:'Celebrating Eid with food, music, and the whole school community.',
      location:'Student Center', organizerUid:'sample-2', tags:['Cultural','Food'], colorTheme:'cool', isFeatured:true },
    { name:'ISA Garba Night', date: firebase.firestore.Timestamp.fromDate(new Date('2024-04-18')),
      description:'Dance off! Annual Garba night hosted by ISA.',
      location:'Main Auditorium', organizerUid:'sample-2', tags:['Dance','Cultural'], colorTheme:'hero', isFeatured:true },
    { name:'RHS Cybersecurity Club', date: firebase.firestore.Timestamp.fromDate(new Date('2024-03-29')),
      description:'Friday meeting! Learn about cybersecurity and CTF challenges.',
      location:'CS Lab 204', organizerUid:'sample-4', tags:['Tech','Club'], colorTheme:'green', isFeatured:true },
  ];
  sampleEvents.forEach(e => batch.set(db.collection('events').doc(), e));
  await batch.commit();
}

// ── Matching (mirrors MatchingService.swift) ──────────────────────────────

function rankOffers(offers) {
  return offers
    .map(o => {
      let score = 0; const reasons = [];
      score += Math.min(o.seatsAvailable, 4) * 10;
      const fill = 1 - ((o.totalSeats - o.seatsAvailable) / o.totalSeats);
      if (fill > 0.75)      { score += 10; }
      else if (fill > 0.25) { score += 30; reasons.push('great fit'); }
      else                  { score += 15; }
      if ((o.notes || '').length > 10) { score += 20; reasons.push('driver left a note'); }
      if (o.seatsAvailable >= 3) reasons.push('plenty of room');
      const reason = reasons.length ? reasons.map(r => r[0].toUpperCase()+r.slice(1)).join(' · ') : 'Available';
      return { offer: o, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function canPostEvents() {
  return ['staff','studentRep'].includes(state.profile?.role);
}

function updateNotifBadge() {
  const myOfferIds = state.offers.filter(o => o.driverUid === state.profile?.uid).map(o => o.id);
  const count = state.requests.filter(r => myOfferIds.includes(r.offerId) && r.status === 'pending').length;
  const badge = document.getElementById('notif-badge');
  const bnavBadge = document.getElementById('bnav-badge');
  [badge, bnavBadge].forEach(b => {
    if (!b) return;
    b.textContent = count;
    b.classList.toggle('hidden', count === 0);
  });
}

function themeIcon(theme) {
  return { warm:'🎉', cool:'🌊', hero:'✨', green:'🌿' }[theme] || '📅';
}

function fmtDate(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function fmtRelative(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60)    return 'Just now';
  if (secs < 3600)  return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

function sampleName(uid) {
  return { 'sample-1':'Rana Ahmed','sample-2':'Aditya Kumar','sample-3':'Sarah Chen',
           'sample-4':'Marcus Johnson','sample-5':'Priya Patel' }[uid] || 'User';
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearAuthError() { document.getElementById('auth-error').classList.add('hidden'); }

function setAuthLoading(on) {
  ['btn-signin','btn-signup'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = on;
  });
}

function friendlyError(err) {
  const code = err.code || '';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) return 'Incorrect email or password.';
  if (code.includes('user-not-found'))   return 'No account found with that email.';
  if (code.includes('email-already'))    return 'An account already exists for this email.';
  if (code.includes('weak-password'))    return 'Password must be at least 6 characters.';
  return err.message || 'Something went wrong. Please try again.';
}
