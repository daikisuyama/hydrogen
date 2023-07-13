import {copy as copyWithFilter} from 'fs-extra/esm';
import {AbortError} from '@shopify/cli-kit/node/error';
import {AbortController} from '@shopify/cli-kit/node/abort';
import {writeFile} from '@shopify/cli-kit/node/fs';
import {joinPath} from '@shopify/cli-kit/node/path';
import {hyphenate} from '@shopify/cli-kit/common/string';
import colors from '@shopify/cli-kit/node/colors';
import {
  renderSuccess,
  renderSelectPrompt,
  renderConfirmationPrompt,
  renderTasks,
} from '@shopify/cli-kit/node/ui';
import {
  createAbortHandler,
  handleCssStrategy,
  handleDependencies,
  handleLanguage,
  handleProjectLocation,
  handleStorefrontLink,
  type SetupSummary,
  type InitOptions,
  handleCliShortcut,
  handleI18n,
  handleRouteGeneration,
  createInitialCommit,
  renderProjectReady,
  commitAll,
  generateProjectEntries,
} from './common.js';
import {createStorefront} from '../graphql/admin/create-storefront.js';
import {waitForJob} from '../graphql/admin/fetch-job.js';
import {getStarterDir} from '../build.js';
import {replaceFileContent} from '../file.js';
import {setStorefront, setUserAccount} from '../shopify-config.js';
import {ALIAS_NAME, getCliCommand} from '../shell.js';
import {CSS_STRATEGY_NAME_MAP} from '../setups/css/index.js';

/**
 * Flow for setting up a project from the locally bundled starter template (hello-world).
 */
export async function setupLocalStarterTemplate(
  options: InitOptions,
  controller: AbortController,
) {
  const templateAction = options.mockShop
    ? 'mock'
    : await renderSelectPrompt<'mock' | 'link'>({
        message: 'Connect to Shopify',
        choices: [
          {
            label: 'Use sample data from Mock.shop (no login required)',
            value: 'mock',
          },
          {label: 'Link your Shopify account', value: 'link'},
        ],
        defaultValue: 'mock',
        abortSignal: controller.signal,
      });

  const storefrontInfo =
    templateAction === 'link'
      ? await handleStorefrontLink(controller)
      : undefined;

  const project = await handleProjectLocation({
    ...options,
    storefrontInfo,
    controller,
  });

  if (!project) return;

  if (templateAction === 'mock') project.storefrontTitle = 'Mock.shop';

  const abort = createAbortHandler(controller, project);

  const createStorefrontPromise =
    storefrontInfo &&
    createStorefront(storefrontInfo.session, storefrontInfo.title)
      .then(async ({storefront, jobId}) => {
        if (jobId) await waitForJob(storefrontInfo.session, jobId);
        return storefront;
      })
      .catch(abort);

  let backgroundWorkPromise: Promise<any> = copyWithFilter(
    getStarterDir(),
    project.directory,
    // Filter out the `app` directory, which will be generated later
    {filter: (filepath: string) => !/\/app\//i.test(filepath)},
  )
    .then(() =>
      // Generate project entries and their file dependencies
      generateProjectEntries({
        rootDirectory: project.directory,
        appDirectory: joinPath(project.directory, 'app'),
        typescript: true, // Will be transpiled later
      }),
    )
    .catch(abort);

  const tasks = [
    {
      title: 'Creating storefront',
      task: async () => {
        await createStorefrontPromise;
      },
    },
    {
      title: 'Setting up project',
      task: async () => {
        await backgroundWorkPromise;
      },
    },
  ];

  backgroundWorkPromise = backgroundWorkPromise.then(() => {
    const promises: Array<Promise<any>> = [
      // Add project name to package.json
      replaceFileContent(
        joinPath(project.directory, 'package.json'),
        false,
        (content) =>
          content.replace(
            /"name": "[^"]+"/,
            `"name": "${hyphenate(storefrontInfo?.title ?? project.name)}"`,
          ),
      ),
    ];

    const envLeadingComment =
      '# The variables added in this file are only available locally in MiniOxygen\n';

    if (storefrontInfo && createStorefrontPromise) {
      promises.push(
        // Save linked storefront in project
        setUserAccount(project.directory, storefrontInfo),
        createStorefrontPromise.then((storefront) =>
          // Save linked storefront in project
          setStorefront(project.directory, storefront),
        ),
        // Write empty dotenv file to fallback to remote Oxygen variables
        writeFile(joinPath(project.directory, '.env'), envLeadingComment),
      );
    } else if (templateAction === 'mock') {
      promises.push(
        // Set required env vars
        writeFile(
          joinPath(project.directory, '.env'),
          envLeadingComment +
            '\n' +
            [
              ['SESSION_SECRET', 'foobar'],
              ['PUBLIC_STORE_DOMAIN', 'mock.shop'],
            ]
              .map(([key, value]) => `${key}="${value}"`)
              .join('\n') +
            '\n',
        ),
      );
    }

    return Promise.all(promises).catch(abort);
  });

  const {language, transpileProject} = await handleLanguage(
    project.directory,
    controller,
    options.language,
  );

  backgroundWorkPromise = backgroundWorkPromise
    .then(() => transpileProject().catch(abort))
    // Directory files are all setup, commit them to git
    .then(() => createInitialCommit(project.directory));

  const {setupCss, cssStrategy} = await handleCssStrategy(
    project.directory,
    controller,
    options.styling,
  );

  if (cssStrategy) {
    backgroundWorkPromise = backgroundWorkPromise
      .then(() => setupCss().catch(abort))
      .then(() =>
        commitAll(
          project.directory,
          'Setup ' + CSS_STRATEGY_NAME_MAP[cssStrategy],
        ),
      );
  }

  const {packageManager, shouldInstallDeps, installDeps} =
    await handleDependencies(
      project.directory,
      controller,
      options.installDeps,
    );

  const setupSummary: SetupSummary = {
    language,
    packageManager,
    cssStrategy,
    depsInstalled: false,
    hasCreatedShortcut: false,
  };

  if (shouldInstallDeps) {
    const installingDepsPromise = backgroundWorkPromise.then(async () => {
      try {
        await installDeps();
        setupSummary.depsInstalled = true;
      } catch (error) {
        setupSummary.depsError = error as AbortError;
      }
    });

    tasks.push({
      title: 'Installing dependencies',
      task: async () => {
        await installingDepsPromise;
      },
    });
  }

  const cliCommand = await getCliCommand('', packageManager);

  const {createShortcut, showShortcutBanner} = await handleCliShortcut(
    controller,
    cliCommand,
    options.shortcut,
  );

  if (createShortcut) {
    backgroundWorkPromise = backgroundWorkPromise.then(async () => {
      setupSummary.hasCreatedShortcut = await createShortcut();
    });

    showShortcutBanner();
  }

  renderSuccess({
    headline: [
      {userInput: storefrontInfo?.title ?? project.name},
      'is ready to build.',
    ],
  });

  const continueWithSetup =
    (options.i18n ?? options.routes) !== undefined ||
    (await renderConfirmationPrompt({
      message: 'Do you want to scaffold routes and core functionality?',
      confirmationMessage: 'Yes, set up now',
      cancellationMessage:
        'No, set up later ' +
        colors.dim(
          `(run \`${createShortcut ? ALIAS_NAME : cliCommand} setup\`)`,
        ),
      abortSignal: controller.signal,
    }));

  if (continueWithSetup) {
    const {i18nStrategy, setupI18n} = await handleI18n(
      controller,
      options.i18n,
    );

    const {routes, setupRoutes} = await handleRouteGeneration(
      controller,
      options.routes || true, // TODO: Remove default value when multi-select UI component is available
    );

    setupSummary.i18n = i18nStrategy;
    setupSummary.routes = routes;
    backgroundWorkPromise = backgroundWorkPromise.then(async () => {
      // These tasks need to be performed in
      // sequence to ensure commits are clean.

      await setupI18n({
        rootDirectory: project.directory,
        serverEntryPoint: language === 'ts' ? 'server.ts' : 'server.js',
      })
        .then(() =>
          commitAll(
            project.directory,
            `Setup internationalization using ${i18nStrategy}`,
          ),
        )
        .catch((error) => {
          setupSummary.i18nError = error as AbortError;
        });

      await setupRoutes(project.directory, language, i18nStrategy)
        .then(() =>
          commitAll(
            project.directory,
            `Generate routes for core functionality`,
          ),
        )
        .catch((error) => {
          setupSummary.routesError = error as AbortError;
        });
    });
  }

  await renderTasks(tasks);

  await commitAll(project.directory, 'Lockfile');

  await renderProjectReady(project, setupSummary);
}
