const { createPool } = require('mysql2/promise');
const { fillPdfForm } = require('./fill_austria_form');
const { loadMappingConfig, buildFieldValues } = require('./mappingLoader');

const FORM_CONFIG = {
  austria: {
    pdf: 'austria.pdf',
    mapping: 'austria',
  },
  portugal: {
    pdf: 'portugal.pdf',
    mapping: 'portugal',
  },
  malta: {
    pdf: 'malta.pdf',
    mapping: 'malta',
  },
};

const DEFAULT_DB_OPTIONS = {
  host: '217.174.153.182',
  port: 3306,
  user: 'visadcouk_hiten',
  password: 'UVih08BdA3wip',
  database: 'visadcouk_dataf',
};

function parseArgs(argv) {
  const options = {
    form: null,
    travelerId: null,
    recordType: 'traveler',
    outputPath: null,
    flatten: false,
    pdfPath: null,
    db: { ...DEFAULT_DB_OPTIONS },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--form':
      case '-f':
        options.form = argv[++i];
        break;
      case '--traveler-id':
      case '-t':
        options.travelerId = Number(argv[++i]);
        break;
      case '--record-type':
        options.recordType = argv[++i];
        break;
      case '--output':
      case '-o':
        options.outputPath = argv[++i];
        break;
      case '--pdf':
        options.pdfPath = argv[++i];
        break;
      case '--flatten':
        options.flatten = true;
        break;
      case '--db-host':
        options.db.host = argv[++i];
        break;
      case '--db-port':
        options.db.port = Number(argv[++i]);
        break;
      case '--db-user':
        options.db.user = argv[++i];
        break;
      case '--db-password':
        options.db.password = argv[++i];
        break;
      case '--db-name':
        options.db.database = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!options.form || !FORM_CONFIG[options.form]) {
    console.error('You must provide a valid --form option (austria, portugal, malta).');
    process.exit(1);
  }

  if (!options.travelerId || Number.isNaN(options.travelerId)) {
    console.error('You must provide --traveler-id with a numeric value.');
    process.exit(1);
  }

  if (!['traveler', 'dependent'].includes(options.recordType)) {
    console.error('--record-type must be "traveler" or "dependent".');
    process.exit(1);
  }

  if (!options.outputPath) {
    options.outputPath = `${options.form}-${options.recordType}-${options.travelerId}.pdf`;
  }

  if (!options.pdfPath) {
    options.pdfPath = FORM_CONFIG[options.form].pdf;
  }

  return options;
}

function printHelp() {
  console.log(`Fill a PDF directly from the database.

Usage:
  node fill_form_from_db.js --form <austria|portugal|malta> --traveler-id <id> [options]

Options:
  -f, --form <name>          Which PDF/template to use
  -t, --traveler-id <id>     Traveler or dependent primary key
      --record-type <type>   "traveler" (default) or "dependent"
  -o, --output <path>        Destination PDF (default derived from args)
      --pdf <path>           Override template path
      --flatten              Flatten form before saving
      --db-host <host>       Database host (default env DB_HOST or localhost)
      --db-port <port>       Database port (default 3306)
      --db-user <user>       Database user
      --db-password <pass>   Database password
      --db-name <db>         Database name
  -h, --help                 Show this message
`);
}

async function fetchRecord(pool, tableName, id) {
  const [rows] = await pool.query(`SELECT * FROM ${tableName} WHERE id = ? LIMIT 1`, [id]);
  if (!rows.length) {
    throw new Error(`No record found in ${tableName} with id ${id}`);
  }
  return rows[0];
}

async function fetchQuestions(pool, recordId, recordType) {
  const [rows] = await pool.query(
    'SELECT * FROM traveler_questions WHERE record_id = ? AND record_type = ? LIMIT 1',
    [recordId, recordType],
  );
  return rows[0] || {};
}

async function buildContextFromDb(pool, options) {
  const isDependent = options.recordType === 'dependent';
  const table = isDependent ? 'dependents' : 'travelers';
  const record = await fetchRecord(pool, table, options.travelerId);
  const questions = await fetchQuestions(pool, options.travelerId, options.recordType);

  let traveler = null;
  let dependent = null;

  if (isDependent) {
    dependent = record;
    traveler = record.traveler_id ? await fetchRecord(pool, 'travelers', record.traveler_id) : null;
  } else {
    traveler = record;
  }

  return {
    traveler,
    dependent,
    record,
    questions,
  };
}

async function fillFormFromDb({
  form,
  travelerId,
  recordType = 'traveler',
  flatten = false,
  pdfPath,
  outputPath,
  expectedTravelCountry,
  db = DEFAULT_DB_OPTIONS,
  pool: externalPool,
}) {
  if (!FORM_CONFIG[form]) {
    throw new Error(`Unsupported form "${form}".`);
  }
  if (!travelerId) {
    throw new Error('The "travelerId" option is required.');
  }
  if (!['traveler', 'dependent'].includes(recordType)) {
    throw new Error('recordType must be "traveler" or "dependent".');
  }

  const resolvedPdfPath = pdfPath || FORM_CONFIG[form].pdf;
  const mappingKey = FORM_CONFIG[form].mapping;

  let pool = externalPool;
  let ownsPool = false;
  if (!pool) {
    pool = await createPool(db);
    ownsPool = true;
  }

  try {
    const context = await buildContextFromDb(pool, { travelerId, recordType });

    if (expectedTravelCountry) {
      const actualCountry =
        context.record?.travel_country || context.traveler?.travel_country || '';
      if (
        actualCountry &&
        actualCountry.toLowerCase() !== expectedTravelCountry.toLowerCase()
      ) {
        throw new Error(
          `Traveler ${travelerId} travel_country "${actualCountry}" does not match expected "${expectedTravelCountry}".`,
        );
      }
    }

    const mappingConfig = await loadMappingConfig(mappingKey);
    const fieldValues = buildFieldValues(mappingConfig, context);

    if (!Object.keys(fieldValues).length) {
      console.warn('No field values were resolved from the mapping. The PDF may remain unchanged.');
    }

    const result = await fillPdfForm({
      inputPath: resolvedPdfPath,
      outputPath,
      data: fieldValues,
      flatten,
    });

    return { ...result, fieldValues };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const { updated, missingFields } = await fillFormFromDb(options);

  console.log(`Filled PDF saved to "${options.outputPath}".`);
  console.log(`Updated fields (${updated.length}): ${updated.join(', ')}`);
  if (missingFields.length) {
    console.warn(`Fields missing from template: ${missingFields.join(', ')}`);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = {
    fillFormFromDb,
    buildContextFromDb,
    FORM_CONFIG,
  };
}

