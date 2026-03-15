/**
 * Generates realistic human-like form data for newsletter signups.
 * Used when brands ask for more than just an email address.
 */

const FIRST_NAMES = [
  'Emma','Olivia','Ava','Sophia','Isabella','Mia','Charlotte','Amelia',
  'Harper','Evelyn','Abigail','Emily','Elizabeth','Sofia','Avery','Ella',
  'Madison','Scarlett','Victoria','Aria','Grace','Chloe','Penelope','Layla',
  'Riley','Zoey','Nora','Lily','Eleanor','Hannah','Lillian','Addison',
  'Aubrey','Ellie','Stella','Natalia','Zoe','Leah','Hazel','Violet',
  'Aurora','Savannah','Audrey','Brooklyn','Bella','Claire','Skylar','Lucy'
];

const LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
  'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson',
  'Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson',
  'White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker',
  'Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores',
  'Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell'
];

// Real US zip codes with city/state context (for form fields that ask for location)
const US_LOCATIONS = [
  { zip: '10001', city: 'New York',     state: 'NY', stateCode: 'NY' },
  { zip: '90001', city: 'Los Angeles',  state: 'CA', stateCode: 'CA' },
  { zip: '60601', city: 'Chicago',      state: 'IL', stateCode: 'IL' },
  { zip: '77001', city: 'Houston',      state: 'TX', stateCode: 'TX' },
  { zip: '85001', city: 'Phoenix',      state: 'AZ', stateCode: 'AZ' },
  { zip: '19101', city: 'Philadelphia', state: 'PA', stateCode: 'PA' },
  { zip: '78201', city: 'San Antonio',  state: 'TX', stateCode: 'TX' },
  { zip: '92101', city: 'San Diego',    state: 'CA', stateCode: 'CA' },
  { zip: '75201', city: 'Dallas',       state: 'TX', stateCode: 'TX' },
  { zip: '95101', city: 'San Jose',     state: 'CA', stateCode: 'CA' },
  { zip: '30301', city: 'Atlanta',      state: 'GA', stateCode: 'GA' },
  { zip: '98101', city: 'Seattle',      state: 'WA', stateCode: 'WA' },
  { zip: '02101', city: 'Boston',       state: 'MA', stateCode: 'MA' },
  { zip: '80201', city: 'Denver',       state: 'CO', stateCode: 'CO' },
  { zip: '33101', city: 'Miami',        state: 'FL', stateCode: 'FL' },
  { zip: '48201', city: 'Detroit',      state: 'MI', stateCode: 'MI' },
  { zip: '97201', city: 'Portland',     state: 'OR', stateCode: 'OR' },
  { zip: '89101', city: 'Las Vegas',    state: 'NV', stateCode: 'NV' },
  { zip: '37201', city: 'Nashville',    state: 'TN', stateCode: 'TN' },
  { zip: '27601', city: 'Raleigh',      state: 'NC', stateCode: 'NC' },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a complete human profile for form filling.
 * All data is consistent (same location across zip/city/state fields).
 */
function generateProfile() {
  const firstName = pick(FIRST_NAMES);
  const lastName  = pick(LAST_NAMES);
  const location  = pick(US_LOCATIONS);

  // Age 2438 (millennial/gen-z  core D2C demographic)
  const birthYear  = new Date().getFullYear() - randomInt(24, 38);
  const birthMonth = String(randomInt(1, 12)).padStart(2, '0');
  const birthDay   = String(randomInt(1, 28)).padStart(2, '0');

  // US phone with area code matching location
  const areaCode = String(randomInt(200, 999));
  const phone    = `${areaCode}${randomInt(100, 999)}${randomInt(1000, 9999)}`;

  return {
    firstName,
    lastName,
    fullName:    `${firstName} ${lastName}`,
    email:       process.env.GMAIL_USER || 'newsletter@example.com',

    // Date of birth variants
    birthday:    `${birthMonth}/${birthDay}/${birthYear}`,
    birthdayISO: `${birthYear}-${birthMonth}-${birthDay}`,
    birthMonth, birthDay,
    birthYear:   String(birthYear),

    // Location
    zip:       location.zip,
    city:      location.city,
    state:     location.state,
    stateCode: location.stateCode,

    // Phone
    phone,
    phoneFormatted: `(${areaCode}) ${phone.slice(3, 6)}-${phone.slice(6)}`,

    // Common preference fields
    gender:   'female',
    country:  'US',
    language: 'en'
  };
}

/**
 * Match a form field label/name/placeholder to the right profile value.
 * Returns [value, confidence] or null if no match.
 */
function matchFieldToProfile(fieldHint, profile) {
  const hint = fieldHint.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Email
  if (/email|mail/.test(hint)) return profile.email;

  // Name variants
  if (/firstname|first_name|fname|givenname/.test(hint)) return profile.firstName;
  if (/lastname|last_name|lname|familyname|surname/.test(hint)) return profile.lastName;
  if (/fullname|name/.test(hint)) return profile.fullName;

  // Location
  if (/zipcode|zip|postal|postcode/.test(hint)) return profile.zip;
  if (/city/.test(hint)) return profile.city;
  if (/state/.test(hint)) return profile.stateCode;
  if (/country/.test(hint)) return profile.country;

  // Phone
  if (/phone|mobile|tel/.test(hint)) return profile.phoneFormatted;

  // Birthday
  if (/birthday|birthdate|dob/.test(hint)) return profile.birthday;
  if (/birthmonth|month/.test(hint)) return profile.birthMonth;
  if (/birthday|day/.test(hint)) return profile.birthDay;
  if (/birthyear|year/.test(hint)) return profile.birthYear;

  // Gender
  if (/gender|sex/.test(hint)) return profile.gender;

  return null;
}

module.exports = { generateProfile, matchFieldToProfile };
