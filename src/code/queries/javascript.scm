; What jev-lint extracts from JavaScript and TypeScript. The TypeScript and TSX grammars extend the
; JavaScript one, so this file serves all three. Supporting another language means another grammar
; and another file with these same capture names; the rules never see a syntax tree.
;
;   @function + @function.name + @function.body   a named function and its body
;   @test + @test.title + @test.body              a test case and its callback
;   @catch + @catch.try + @catch.body             a catch clause, the block it guards, and its own block
;   @pcatch + @pcatch.try + @pcatch.body          `.catch(fn)` on a promise, the expression it is chained to, and fn's block
;   @guard + @guard.condition + @guard.message    an `if` whose only consequence is to throw a literal message
;   @asserted + @asserted.message                 an assertion call whose last argument is a literal message
;   @named + @named.name + @named.value           a variable whose name reads as a yes/no question, and its value
;   @comment                                      every comment; adjacency is resolved in code

(function_declaration
  name: (identifier) @function.name
  parameters: (formal_parameters) @function.params
  body: (statement_block) @function.body) @function

(generator_function_declaration
  name: (identifier) @function.name
  parameters: (formal_parameters) @function.params
  body: (statement_block) @function.body) @function

(method_definition
  name: (property_identifier) @function.name
  parameters: (formal_parameters) @function.params
  body: (statement_block) @function.body
  (#not-eq? @function.name "constructor")) @function

(method_definition
  name: (private_property_identifier) @function.name
  parameters: (formal_parameters) @function.params
  body: (statement_block) @function.body) @function

; `exports.parse = function () {}`, `Foo.prototype.isDone = () => …`
(assignment_expression
  left: [(identifier) @function.name (member_expression property: (property_identifier) @function.name)]
  right: [
    (arrow_function [parameters: (formal_parameters) parameter: (identifier)] @function.params body: (_) @function.body)
    (function_expression parameters: (formal_parameters) @function.params body: (statement_block) @function.body)
  ]) @function

; `parameters` when the arrow function has a parenthesised list, `parameter` when it has one bare name.
(variable_declarator
  name: (identifier) @function.name
  value: [
    (arrow_function [parameters: (formal_parameters) parameter: (identifier)] @function.params body: (_) @function.body)
    (function_expression parameters: (formal_parameters) @function.params body: (statement_block) @function.body)
  ]) @function

(if_statement
  condition: (parenthesized_expression) @guard.condition
  consequence: [
    (statement_block . (throw_statement (new_expression arguments: (arguments . [(string) (template_string)] @guard.message))) .)
    (throw_statement (new_expression arguments: (arguments . [(string) (template_string)] @guard.message)))
  ]
  !alternative) @guard

(call_expression
  function: [
    (identifier) @_runner
    (member_expression object: (identifier) @_runner)
  ]
  arguments: (arguments
    .
    [(string) (template_string)] @test.title
    [(arrow_function) (function_expression)] @test.body)
  (#any-of? @_runner "it" "test")) @test

(try_statement
  body: (statement_block) @catch.try
  handler: (catch_clause body: (statement_block) @catch.body) @catch)

; `assert(check, "message")` and its kind: the message is raised when the check fails. Code picks the check,
; which is the argument just before the message.
(call_expression
  function: [
    (identifier) @_assert
    (member_expression property: (property_identifier) @_assert)
  ]
  arguments: (arguments (_) [(string) (template_string)] @asserted.message .)
  (#match? @_assert "^(assert|invariant|ensure|precondition|ok)$|[aA]ssert|[iI]nvariant")) @asserted

; A variable named like a yes/no question. Code decides whether its value is plainly not a boolean.
(variable_declarator
  name: (identifier) @named.name
  value: (_) @named.value
  (#match? @named.name "^(is|has|should|can|was|did)[A-Z]")) @named

; `promise.catch(() => {})`: the same swallowed error, written as a chain.
(call_expression
  function: (member_expression
    object: (_) @pcatch.try
    property: (property_identifier) @_catch)
  arguments: (arguments
    .
    [
      (arrow_function body: (statement_block) @pcatch.body)
      (function_expression body: (statement_block) @pcatch.body)
    ]
    .)
  (#eq? @_catch "catch")) @pcatch

(comment) @comment
