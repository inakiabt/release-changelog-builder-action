import * as core from '@actions/core'
import {Category, Configuration, Placeholder, Property} from './configuration'
import {createOrSet, haveCommonElementsArr, haveEveryElementsArr} from './utils'
import {
  CommentInfo,
  EMPTY_COMMENT_INFO,
  EMPTY_PULL_REQUEST_INFO,
  PullRequestInfo,
  retrieveProperty,
  sortPullRequests
} from 'github-pr-collector/lib/pullRequests'
import {DiffInfo} from 'github-pr-collector/lib/commits'
import {validateTransformer} from 'github-pr-collector/lib/regexUtils'
import {Transformer, RegexTransformer} from 'github-pr-collector/lib/types'
import {ReleaseNotesOptions} from './releaseNotesBuilder'
import {matchesRules} from './regexUtils'

const EMPTY_MAP = new Map<string, string>()

export interface PullRequestData extends PullRequestInfo {
  childPrs?: PullRequestInfo[]
}

export function buildChangelog(diffInfo: DiffInfo, origPrs: PullRequestInfo[], options: ReleaseNotesOptions): string {
  core.startGroup('📦 Build changelog')

  let prs: PullRequestData[] = origPrs
  if (prs.length === 0) {
    core.warning(`⚠️ No pull requests found`)
    const result = replaceEmptyTemplate(options.configuration.empty_template, options)
    core.endGroup()
    return result
  }

  // sort to target order
  const config = options.configuration
  const sort = config.sort
  prs = sortPullRequests(prs, sort)
  core.info(`ℹ️ Sorted all pull requests ascending: ${JSON.stringify(sort)}`)

  // establish parent child PR relations
  if (config.reference !== undefined) {
    const reference = validateTransformer(config.reference)
    if (reference !== null) {
      core.info(`ℹ️ Identifying PR references using \`reference\``)

      const mapped = new Map<number, PullRequestData>()
      for (const pr of prs) {
        mapped.set(pr.number, pr)
      }

      const remappedPrs: PullRequestData[] = []
      for (const pr of prs) {
        const extracted = extractValues(pr, reference, 'reference')
        if (extracted !== null && extracted.length > 0) {
          const foundNumber = parseInt(extracted[0])
          const valid = !isNaN(foundNumber)
          const parent = mapped.get(foundNumber)
          if (valid && parent !== undefined) {
            if (parent.childPrs === undefined) {
              parent.childPrs = []
            }
            parent.childPrs.push(pr)
          } else {
            if (!valid) core.warning(`⚠️ Extracted reference 'isNaN': ${extracted}`)
            remappedPrs.push(pr)
          }
        } else {
          remappedPrs.push(pr)
        }
      }
      prs = remappedPrs
    } else {
      core.warning(`⚠️ Configured \`reference\` invalid.`)
    }
  }

  // drop duplicate pull requests
  if (config.duplicate_filter !== undefined) {
    const extractor = validateTransformer(config.duplicate_filter)
    if (extractor !== null) {
      core.info(`ℹ️ Remove duplicated pull requests using \`duplicate_filter\``)

      const deduplicatedMap = new Map<string, PullRequestInfo>()
      const unmatched: PullRequestInfo[] = []
      for (const pr of prs) {
        const extracted = extractValues(pr, extractor, 'dupliate_filter')
        if (extracted !== null && extracted.length > 0) {
          deduplicatedMap.set(extracted[0], pr)
        } else {
          core.info(`  PR (${pr.number}) did not resolve an ID using the \`duplicate_filter\``)
          unmatched.push(pr)
        }
      }
      const deduplicatedPRs = Array.from(deduplicatedMap.values())
      deduplicatedPRs.push(...unmatched) // add all unmatched PRs to map
      const removedElements = prs.length - deduplicatedPRs.length
      core.info(`ℹ️ Removed ${removedElements} pull requests during deduplication`)
      prs = sortPullRequests(deduplicatedPRs, sort) // resort deduplicatedPRs
    } else {
      core.warning(`⚠️ Configured \`duplicate_filter\` invalid.`)
    }
  }

  // extract additional labels from the commit message
  const labelExtractors = validateTransformers(config.label_extractor)
  for (const extractor of labelExtractors) {
    for (const pr of prs) {
      const extracted = extractValues(pr, extractor, 'label_extractor')
      if (extracted !== null) {
        for (const label of extracted) {
          pr.labels.push(label)
        }

        if (core.isDebug()) {
          core.debug(`    Extracted the following labels (${JSON.stringify(extracted)}) for PR ${pr.number}`)
        }
      }
    }
  }

  // keep reference for the placeholder values
  const placeholders = new Map<string, Placeholder[]>()
  for (const ph of config.custom_placeholders || []) {
    createOrSet(placeholders, ph.source, ph)
  }
  const placeholderPrMap = new Map<string, string[]>()

  const validatedTransformers = validateTransformers(config.transformers)
  const transformedMap = new Map<PullRequestInfo, string>()
  // convert PRs to their text representation
  for (const pr of prs) {
    transformedMap.set(pr, transform(fillPrTemplate(pr, config.pr_template, placeholders, placeholderPrMap, config), validatedTransformers))
  }
  core.info(`ℹ️ Used ${validatedTransformers.length} transformers to adjust message`)
  core.info(`✒️ Wrote messages for ${prs.length} pull requests`)

  // bring PRs into the order of categories
  const categorized = new Map<Category, string[]>()
  const categories = config.categories
  const ignoredLabels = config.ignore_labels

  for (const category of categories) {
    categorized.set(category, [])
  }

  const categorizedPrs: string[] = []
  const ignoredPrs: string[] = []
  const openPrs: string[] = []
  const uncategorizedPrs: string[] = []

  // bring elements in order
  for (const [pr, body] of transformedMap) {
    if (
      haveCommonElementsArr(
        ignoredLabels.map(lbl => lbl.toLocaleLowerCase('en')),
        pr.labels
      )
    ) {
      ignoredPrs.push(body)
      continue
    }

    if (pr.status === 'open') {
      openPrs.push(body)
    }

    let matchedOnce = false // in case we matched once at least, the PR can't be uncategorized
    for (const [category, pullRequests] of categorized) {
      let matched = false // check if we matched within the given category
      // check if any exclude label matches
      if (category.exclude_labels !== undefined) {
        if (
          haveCommonElementsArr(
            category.exclude_labels.map(lbl => lbl.toLocaleLowerCase('en')),
            pr.labels
          )
        ) {
          if (core.isDebug()) {
            const excludeLabels = JSON.stringify(category.exclude_labels)
            core.debug(`    PR ${pr.number} with labels: ${pr.labels} excluded from category via exclude label: ${excludeLabels}`)
          }
          continue // one of the exclude labels matched, skip the PR for this category
        }
      }

      // in case we have exhaustive matching enabled, and have labels and/or rules
      // validate for an exhaustive match (e.g. every provided rule applies)
      if (category.exhaustive === true && (category.labels !== undefined || category.rules !== undefined)) {
        if (category.labels !== undefined) {
          matched = haveEveryElementsArr(
            category.labels.map(lbl => lbl.toLocaleLowerCase('en')),
            pr.labels
          )
        }
        let exhaustive_rules = true
        if (category.exhaustive_rules !== undefined) {
          exhaustive_rules = category.exhaustive_rules
        }
        if (matched && category.rules !== undefined) {
          matched = matchesRules(category.rules, pr, exhaustive_rules)
        }
      } else {
        // if not exhaustive, do individual matches
        if (category.labels !== undefined) {
          // check if either any of the labels applies
          matched = haveCommonElementsArr(
            category.labels.map(lbl => lbl.toLocaleLowerCase('en')),
            pr.labels
          )
        }
        let exhaustive_rules = false
        if (category.exhaustive_rules !== undefined) {
          exhaustive_rules = category.exhaustive_rules
        }
        if (!matched && category.rules !== undefined) {
          // if no label did apply, check if any rule applies
          matched = matchesRules(category.rules, pr, exhaustive_rules)
        }
      }
      if (matched) {
        pullRequests.push(body) // if matched add the PR to the list
      }
      matchedOnce = matchedOnce || matched
    }

    if (!matchedOnce) {
      // we allow to have pull requests included in an "uncategorized" category
      for (const [category, pullRequests] of categorized) {
        if ((category.labels === undefined || category.labels.length === 0) && category.rules === undefined) {
          pullRequests.push(body)
          break
        }
      }
      uncategorizedPrs.push(body)
    } else {
      categorizedPrs.push(body)
    }
  }
  core.info(`ℹ️ Ordered all pull requests into ${categories.length} categories`)

  // serialize and provide the categorized content as json
  const transformedCategorized = Array.from(categorized).reduce(
    (obj, [key, value]) => Object.assign(obj, {[key.key || key.title]: value}),
    {}
  )
  core.setOutput('categorized', JSON.stringify(transformedCategorized))

  // construct final changelog
  let changelog = ''
  for (const [category, pullRequests] of categorized) {
    if (pullRequests.length > 0) {
      if (category.title) {
        changelog = `${changelog + category.title}\n\n`
      }

      for (const pr of pullRequests) {
        changelog = `${changelog + pr}\n`
      }
      changelog = `${changelog}\n` // add space between sections
    } else if (category.empty_content !== undefined) {
      if (category.title) {
        changelog = `${changelog + category.title}\n\n`
      }
      changelog = `${changelog + category.empty_content}\n\n`
    }
  }
  core.info(`✒️ Wrote ${categorizedPrs.length} categorized pull requests down`)
  if (core.isDebug()) {
    for (const pr of categorizedPrs) {
      core.debug(`    ${pr}`)
    }
  }
  core.setOutput('categorized_prs', categorizedPrs.length)

  let changelogUncategorized = ''
  for (const pr of uncategorizedPrs) {
    changelogUncategorized = `${changelogUncategorized + pr}\n`
  }
  core.info(`✒️ Wrote ${uncategorizedPrs.length} non categorized pull requests down`)
  if (core.isDebug()) {
    for (const pr of uncategorizedPrs) {
      core.debug(`    ${pr}`)
    }
  }
  core.setOutput('uncategorized_prs', uncategorizedPrs.length)

  let changelogOpen = ''
  if (openPrs.length > 0) {
    for (const pr of openPrs) {
      changelogOpen = `${changelogOpen + pr}\n`
    }
    core.info(`✒️ Wrote ${openPrs.length} open pull requests down`)
    if (core.isDebug()) {
      for (const pr of openPrs) {
        core.debug(`    ${pr}`)
      }
    }
    core.setOutput('open_prs', openPrs.length)
  }

  let changelogIgnored = ''
  for (const pr of ignoredPrs) {
    changelogIgnored = `${changelogIgnored + pr}\n`
  }
  if (core.isDebug()) {
    for (const pr of ignoredPrs) {
      core.debug(`    ${pr}`)
    }
  }
  core.info(`✒️ Wrote ${ignoredPrs.length} ignored pull requests down`)

  // fill template
  const placeholderMap = new Map<string, string>()
  placeholderMap.set('CHANGELOG', changelog)
  placeholderMap.set('UNCATEGORIZED', changelogUncategorized)
  placeholderMap.set('OPEN', changelogOpen)
  placeholderMap.set('IGNORED', changelogIgnored)
  // fill other placeholders
  placeholderMap.set('CATEGORIZED_COUNT', categorizedPrs.length.toString())
  placeholderMap.set('UNCATEGORIZED_COUNT', uncategorizedPrs.length.toString())
  placeholderMap.set('OPEN_COUNT', openPrs.length.toString())
  placeholderMap.set('IGNORED_COUNT', ignoredPrs.length.toString())
  // code change placeholders
  placeholderMap.set('CHANGED_FILES', diffInfo.changedFiles.toString())
  placeholderMap.set('ADDITIONS', diffInfo.additions.toString())
  placeholderMap.set('DELETIONS', diffInfo.deletions.toString())
  placeholderMap.set('CHANGES', diffInfo.changes.toString())
  placeholderMap.set('COMMITS', diffInfo.commits.toString())
  fillAdditionalPlaceholders(options, placeholderMap)

  let transformedChangelog = config.template
  transformedChangelog = replacePlaceholders(transformedChangelog, EMPTY_MAP, placeholderMap, placeholders, placeholderPrMap, config)
  transformedChangelog = replacePrPlaceholders(transformedChangelog, placeholderPrMap, config)
  transformedChangelog = cleanupPrPlaceholders(transformedChangelog, placeholders)
  transformedChangelog = cleanupPlaceholders(transformedChangelog)
  core.info(`ℹ️ Filled template`)
  core.endGroup()
  return transformedChangelog
}

export function replaceEmptyTemplate(template: string, options: ReleaseNotesOptions): string {
  const placeholders = new Map<string, Placeholder[]>()
  for (const ph of options.configuration.custom_placeholders || []) {
    createOrSet(placeholders, ph.source, ph)
  }
  const placeholderMap = new Map<string, string>()
  fillAdditionalPlaceholders(options, placeholderMap)
  return replacePlaceholders(template, EMPTY_MAP, placeholderMap, placeholders, undefined, options.configuration)
}

function fillAdditionalPlaceholders(
  options: ReleaseNotesOptions,
  placeholderMap: Map<string, string> /* placeholderKey and original value */
): void {
  placeholderMap.set('OWNER', options.owner)
  placeholderMap.set('REPO', options.repo)
  placeholderMap.set('FROM_TAG', options.fromTag.name)
  placeholderMap.set('FROM_TAG_DATE', options.fromTag.date?.toISOString() || '')
  placeholderMap.set('TO_TAG', options.toTag.name)
  placeholderMap.set('TO_TAG_DATE', options.toTag.date?.toISOString() || '')
  const fromDate = options.fromTag.date
  const toDate = options.toTag.date
  if (fromDate !== undefined && toDate !== undefined) {
    placeholderMap.set('DAYS_SINCE', toDate.diff(fromDate, 'days').toString() || '')
  } else {
    placeholderMap.set('DAYS_SINCE', '')
  }
  placeholderMap.set(
    'RELEASE_DIFF',
    `https://github.com/${options.owner}/${options.repo}/compare/${options.fromTag.name}...${options.toTag.name}`
  )
}

function fillPrTemplate(
  pr: PullRequestData,
  template: string,
  placeholders: Map<string, Placeholder[]> /* placeholders to apply */,
  placeholderPrMap: Map<string, string[]> /* map to keep replaced placeholder values with their key */,
  configuration: Configuration
): string {
  const arrayPlaceholderMap = new Map<string, string>()
  fillReviewPlaceholders(arrayPlaceholderMap, 'REVIEWS', pr.reviews || [])
  fillChildPrPlaceholders(arrayPlaceholderMap, 'REFERENCED', pr.childPrs || [])
  const placeholderMap = new Map<string, string>()
  placeholderMap.set('NUMBER', pr.number.toString())
  placeholderMap.set('TITLE', pr.title)
  placeholderMap.set('URL', pr.htmlURL)
  placeholderMap.set('STATUS', pr.status)
  placeholderMap.set('CREATED_AT', pr.createdAt.toISOString())
  placeholderMap.set('MERGED_AT', pr.mergedAt?.toISOString() || '')
  placeholderMap.set('MERGE_SHA', pr.mergeCommitSha)
  placeholderMap.set('AUTHOR', pr.author)
  placeholderMap.set('LABELS', [...pr.labels]?.filter(l => !l.startsWith('--rcba-'))?.join(', ') || '')
  placeholderMap.set('MILESTONE', pr.milestone || '')
  placeholderMap.set('BODY', pr.body)
  fillArrayPlaceholders(arrayPlaceholderMap, 'ASSIGNEES', pr.assignees || [])
  placeholderMap.set('ASSIGNEES', pr.assignees?.join(', ') || '')
  fillArrayPlaceholders(arrayPlaceholderMap, 'REVIEWERS', pr.requestedReviewers || [])
  placeholderMap.set('REVIEWERS', pr.requestedReviewers?.join(', ') || '')
  fillArrayPlaceholders(arrayPlaceholderMap, 'APPROVERS', pr.approvedReviewers || [])
  placeholderMap.set('APPROVERS', pr.approvedReviewers?.join(', ') || '')
  placeholderMap.set('BRANCH', pr.branch || '')
  placeholderMap.set('BASE_BRANCH', pr.baseBranch)
  return replacePlaceholders(template, arrayPlaceholderMap, placeholderMap, placeholders, placeholderPrMap, configuration)
}

function replacePlaceholders(
  template: string,
  arrayPlaceholderMap: Map<string, string> /* arrayPlaceholderKey and original value */,
  placeholderMap: Map<string, string> /* placeholderKey and original value */,
  placeholders: Map<string, Placeholder[]> /* placeholders to apply */,
  placeholderPrMap: Map<string, string[]> | undefined /* map to keep replaced placeholder values with their key */,
  configuration: Configuration
): string {
  let transformed = template

  // replace array placeholders first
  for (const [key, value] of arrayPlaceholderMap) {
    transformed = handlePlaceholder(transformed, key, value, placeholders, placeholderPrMap, configuration)
  }

  // replace traditional placeholders
  for (const [key, value] of placeholderMap) {
    transformed = handlePlaceholder(transformed, key, value, placeholders, placeholderPrMap, configuration)
  }

  return transformed
}

function handlePlaceholder(
  template: string,
  key: string,
  value: string,
  placeholders: Map<string, Placeholder[]> /* placeholders to apply */,
  placeholderPrMap: Map<string, string[]> | undefined /* map to keep replaced placeholder values with their key */,
  configuration: Configuration
): string {
  let transformed = template.replaceAll(`\${{${key}}}`, configuration.trim_values ? value.trim() : value)
  // replace custom placeholders
  const phs = placeholders.get(key)
  if (phs) {
    for (const placeholder of phs) {
      const transformer = validateTransformer(placeholder.transformer)
      if (transformer?.pattern) {
        const extractedValue = value.replace(transformer.pattern, transformer.target)
        // note: `.replace` will return the full string again if there was no match
        if (extractedValue && (extractedValue !== value || (extractedValue === value && value.match(transformer.pattern)))) {
          if (placeholderPrMap) {
            createOrSet(placeholderPrMap, placeholder.name, extractedValue)
          }
          transformed = transformed.replaceAll(
            `\${{${placeholder.name}}}`,
            configuration.trim_values ? extractedValue.trim() : extractedValue
          )

          if (core.isDebug()) {
            core.debug(`    Custom Placeholder successfully matched data - ${extractValues} (${placeholder.name})`)
          }
        } else if (core.isDebug() && extractedValue === value) {
          core.debug(`    Custom Placeholder did result in the full original value returned. Skipping. (${placeholder.name})`)
        }
      }
    }
  }
  return transformed
}

function fillArrayPlaceholders(
  placeholderMap: Map<string, string> /* placeholderKey and original value */,
  key: string,
  values: string[]
): void {
  if (values.length === 0) return
  for (let i = 0; i < values.length; i++) {
    placeholderMap.set(`${key}[${i}]`, values[i])
  }
  placeholderMap.set(`${key}[*]`, values.join(', '))
}

function fillReviewPlaceholders(
  placeholderMap: Map<string, string> /* placeholderKey and original value */,
  parentKey: string,
  values: CommentInfo[]
): void {
  if (values.length === 0) return
  // retrieve the keys from the CommentInfo object
  for (const childKey of Object.keys(EMPTY_COMMENT_INFO)) {
    for (let i = 0; i < values.length; i++) {
      placeholderMap.set(`${parentKey}[${i}].${childKey}`, values[i][childKey as keyof CommentInfo]?.toLocaleString('en') || '')
    }
    placeholderMap.set(
      `${parentKey}[*].${childKey}`,
      values.map(value => value[childKey as keyof CommentInfo]?.toLocaleString('en') || '').join(', ')
    )
  }
}

function fillChildPrPlaceholders(
  placeholderMap: Map<string, string> /* placeholderKey and original value */,
  parentKey: string,
  values: PullRequestInfo[]
): void {
  if (values.length === 0) return
  // retrieve the keys from the PullRequestInfo object
  for (const childKey of Object.keys(EMPTY_PULL_REQUEST_INFO)) {
    for (let i = 0; i < values.length; i++) {
      placeholderMap.set(`${parentKey}[${i}].${childKey}`, values[i][childKey as keyof PullRequestInfo]?.toLocaleString('en') || '')
    }
    placeholderMap.set(
      `${parentKey}[*].${childKey}`,
      values.map(value => value[childKey as keyof PullRequestInfo]?.toLocaleString('en') || '').join(', ')
    )
  }
}

function replacePrPlaceholders(
  template: string,
  placeholderPrMap: Map<string, string[]> /* map with all pr related custom placeholder values */,
  configuration: Configuration
): string {
  let transformed = template
  for (const [key, values] of placeholderPrMap) {
    for (let i = 0; i < values.length; i++) {
      transformed = transformed.replaceAll(`\${{${key}[${i}]}}`, configuration.trim_values ? values[i].trim() : values[i])
    }
    transformed = transformed.replaceAll(`\${{${key}[*]}}`, values.join(''))
  }
  return transformed
}

function cleanupPrPlaceholders(template: string, placeholders: Map<string, Placeholder[]>): string {
  let transformed = template
  for (const [, phs] of placeholders) {
    for (const ph of phs) {
      transformed = transformed.replaceAll(new RegExp(`\\$\\{\\{${ph.name}(?:\\[.+?\\])?\\}\\}`, 'gu'), '')
    }
  }
  return transformed
}

function cleanupPlaceholders(template: string): string {
  let transformed = template
  for (const phs of ['REVIEWS', 'REFERENCED', 'ASSIGNEES', 'REVIEWERS', 'APPROVERS']) {
    transformed = transformed.replaceAll(new RegExp(`\\$\\{\\{${phs}\\[.+?\\]\\..*?\\}\\}`, 'gu'), '')
  }
  return transformed
}

function transform(filled: string, transformers: RegexTransformer[]): string {
  if (transformers.length === 0) {
    return filled
  }
  let transformed = filled
  for (const {target, pattern} of transformers) {
    if (pattern) {
      transformed = transformed.replace(pattern, target)
    }
  }
  return transformed
}

function validateTransformers(specifiedTransformers: Transformer[]): RegexTransformer[] {
  const transformers = specifiedTransformers
  return transformers
    .map(transformer => {
      return validateTransformer(transformer)
    })
    .filter(transformer => transformer?.pattern != null)
    .map(transformer => {
      return transformer as RegexTransformer
    })
}

function extractValues(pr: PullRequestInfo, extractor: RegexTransformer, extractor_usecase: string): string[] | null {
  if (extractor.pattern == null) {
    return null
  }

  if (extractor.onProperty !== undefined) {
    let results: string[] = []
    const list: Property[] = extractor.onProperty
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < list.length; i++) {
      const prop = list[i]
      const value = retrieveProperty(pr, prop, extractor_usecase)
      const values = extractValuesFromString(value, extractor)
      if (values !== null) {
        results = results.concat(values)
      }
    }
    return results
  } else {
    return extractValuesFromString(pr.body, extractor)
  }
}

function extractValuesFromString(value: string, extractor: RegexTransformer): string[] | null {
  if (extractor.pattern == null) {
    return null
  }

  if (extractor.method === 'match') {
    const lables = value.match(extractor.pattern)
    if (lables !== null && lables.length > 0) {
      return lables.map(label => label?.toLocaleLowerCase('en') || '')
    }
  } else {
    const label = value.replace(extractor.pattern, extractor.target)
    if (label !== '') {
      return [label.toLocaleLowerCase('en')]
    }
  }
  if (extractor.onEmpty !== undefined) {
    return [extractor.onEmpty.toLocaleLowerCase('en')]
  }
  return null
}
