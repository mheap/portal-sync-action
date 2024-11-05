let pat;
const fetch = require("node-fetch");

(async function () {
  const fs = require("fs");
  const path = require("path");

  const matter = require("gray-matter");
  const yaml = require("js-yaml");

  const args = process.argv.slice(2);

  const options = args.reduce((acc, arg, index) => {
    if (arg.startsWith("--")) {
      acc[arg.slice(2)] = args[index + 1];
    }
    return acc;
  }, {});

  pat = options.pat;

  // Override for GitHub Actions
  if (process.env.INPUT_KONNECT_PAT) {
    pat = process.env.INPUT_KONNECT_PAT;
  }

  // Get the directory the command is run from
  const rootDir = "/Users/michael/portal-src"; //process.cwd();

  // Load the config
  const configPath = path.join(rootDir, "portal.yaml");
  const config = yaml.load(fs.readFileSync(configPath, "utf8"));

  // Sync pages
  console.log("Syncing pages...");

  const pages = fs.readdirSync(path.join(rootDir, "pages"));

  // Read the file, parse with gray-matter
  const pageData = pages.map((page) => {
    const filePath = path.join(rootDir, "pages", page);
    const file = fs.readFileSync(filePath, "utf8");
    const f = matter(file);

    let url = "/" + path.basename(page, ".md");
    if (f.data.path) {
      url = "/" + f.data.path;
    }
    return { ...f, filePath, url };
  });

  // Fetch all pages from the API
  const { data: apiPages } = await getApi(
    `/v2/portals/${config.portalId}/pages`
  );

  // Key apiPages on url
  const apiPagesByKey = apiPages.reduce((acc, page) => {
    acc[page.path] = page;
    return acc;
  }, {});

  // Sync pages
  for (const page of pageData) {
    const { url } = page;

    // Check if the page exists
    const apiPage = apiPagesByKey[url];

    const body = {
      title: page.data.title,
      public: page.data.visibility == "public",
      published: page.data.published,
      content: page.content.trim(),
      path: page.url,
    };

    if (apiPage) {
      // Update the page
      console.log(`Updating page ${url}`);
      const r = await patchApi(
        `/v2/portals/${config.portalId}/pages/${apiPage.id}`,
        body
      );
    } else {
      // Create the page
      console.log(`Creating page ${url}`);
      const r = await postApi(`/v2/portals/${config.portalId}/pages`, body);
    }
  }

  // Load styles
  const stylePath = path.join(rootDir, "assets", "style.css");
  const style = fs.readFileSync(stylePath, "utf8");

  // Load robots.txt
  const robotsPath = path.join(rootDir, "assets", "robots.txt");
  const robots = fs.readFileSync(robotsPath, "utf8");

  // Sync customizations
  console.log("Syncing styles...");
  console.log("Syncing robots...");

  await patchApi(`/v2/portals/${config.portalId}/customization`, {
    data: {
      css: style,
      robots,
    },
  });

  console.log("Syncing menus...");
  config.menu.header = config.menu.header.map((item) => {
    item.external = item.external || false;
    item.public = item.public || true;
    return item;
  });

  config.menu.footer_bottom = config.menu.footer_bottom.map((item) => {
    item.external = item.external || false;
    item.public = item.public || true;
    return item;
  });

  await patchApi(`/v2/portals/${config.portalId}/config`, {
    data: {
      menu: config.menu,
    },
  });

  // Sync APIs
  console.log("Syncing APIs...");

  // Existing APIs
  let { data: apiData } = await getApi(`/v2/api-products`);

  // Key based on name
  let apiDataByKey = apiData.reduce((acc, api) => {
    acc[api.name] = api;
    return acc;
  }, {});

  // Sync APIs
  // List apis folder
  let hasNewApi = false;
  const apis = fs.readdirSync(path.join(rootDir, "apis"));
  for (const api of apis) {
    // Load the openapi file
    const filePath = path.join(rootDir, "apis", api);
    const oas = yaml.load(
      fs.readFileSync(path.join(filePath, "openapi.yaml"), "utf8")
    );

    const name = oas.info.title;
    const description = oas.info.description;

    const body = {
      name,
      description,
    };

    const existingApi = apiDataByKey[name];

    if (existingApi) {
      console.log(`Updating API - ${name}`);
      await patchApi(`/v2/api-products/${existingApi.id}`, body);
    } else {
      console.log(`Creating API - ${name}`);
      await postApi(`/v2/api-products`, body);
      hasNewApi = true;
    }
  }

  if (hasNewApi) {
    // Refresh API products
    apiData = (await getApi(`/v2/api-products`)).data;

    // Key based on name
    apiDataByKey = apiData.reduce((acc, api) => {
      acc[api.name] = api;
      return acc;
    }, {});
  }

  // Create product version
  for (const api of apis) {
    const filePath = path.join(rootDir, "apis", api);
    const oasContent = fs.readFileSync(
      path.join(filePath, "openapi.yaml"),
      "utf8"
    );
    const oas = yaml.load(oasContent);

    const name = oas.info.title;
    const version = "v" + oas.info.version.split(".")[0];

    // Brute force POST and update
    const versions = await getApi(
      `/v2/api-products/${apiDataByKey[name].id}/product-versions`
    );

    const versionsByKey = versions.data.reduce((acc, version) => {
      acc[version.name] = version;
      return acc;
    }, {});

    let versionId;
    if (!versionsByKey[version]) {
      const r = await postApi(
        `/v2/api-products/${apiDataByKey[name].id}/product-versions`,
        {
          name: version,
        }
      );
      versionId = r.id;
    } else {
      const r = await patchApi(
        `/v2/api-products/${apiDataByKey[name].id}/product-versions/${versionsByKey[version].id}`,
        {
          name: version,
        }
      );
      versionId = r.id;
    }

    // Update the spec for this version
    const specs = await getApi(
      `/v2/api-products/${apiDataByKey[name].id}/product-versions/${versionId}/specifications`
    );

    const specBody = {
      name: "openapi.yaml",
      content: Buffer.from(oasContent, "utf8").toString("base64"),
    };

    if (specs.data.length == 0) {
      await postApi(
        `/v2/api-products/${apiDataByKey[name].id}/product-versions/${versionId}/specifications`,
        specBody
      );
    } else {
      await patchApi(
        `/v2/api-products/${apiDataByKey[name].id}/product-versions/${versionId}/specifications/${specs.data[0].id}`,
        specBody
      );
    }
  }
})();

async function getApi(url) {
  url = `https://us.api.konghq.tech${url}`;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pat}`,
    },
  });

  return r.json();
}

async function postApi(url, data) {
  url = `https://us.api.konghq.tech${url}`;
  const r = await fetch(url, {
    method: "POST",
    body: JSON.stringify(data),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pat}`,
    },
  });

  return r.json();
}

async function patchApi(url, data) {
  url = `https://us.api.konghq.tech${url}`;
  const r = await fetch(url, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pat}`,
    },
  });
  return r.json();
}
